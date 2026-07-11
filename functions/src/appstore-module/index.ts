import { logger } from "firebase-functions/v2";
import * as crypto from "crypto";
import * as corsLib from "cors";
import { onRequest } from "firebase-functions/v2/https";

import {
  AppStoreServerAPIClient,
  Environment,
  GetTransactionHistoryVersion,
  Order,
  ProductType,
  HistoryResponse,
  SignedDataVerifier,
  TransactionHistoryRequest,
} from "@apple/app-store-server-library";

const issuerId = process.env.APPLE_ISSUER_ID || "";
const keyId = process.env.APPLE_KEY_ID || "V6V256U3QR";
const bundleId = "com.penpack.listeasy";
const appleEnvironment = (
  process.env.APPLE_ENVIRONMENT || "sandbox"
).toLowerCase();
const environment =
  appleEnvironment === "production"
    ? Environment.PRODUCTION
    : appleEnvironment === "xcode"
      ? Environment.XCODE
      : appleEnvironment === "local_testing"
        ? Environment.LOCAL_TESTING
        : Environment.SANDBOX;
const privateKey = process.env.APPLE_PRIVATE_KEY || "";
const allowedProductIds = (process.env.APPLE_ALLOWED_PRODUCT_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const parseAppleRootCertificates = (input?: string): Buffer[] => {
  if (!input?.trim()) {
    return [];
  }

  const normalizedInput = input.replace(/\\n/g, "\n").trim();
  const candidatePem = normalizedInput.includes("-----BEGIN CERTIFICATE-----")
    ? normalizedInput
    : Buffer.from(normalizedInput, "base64").toString("utf8");

  const pemBlocks = (
    candidatePem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g,
    ) ?? []
  ).map((pem) => pem.trim());

  return pemBlocks
    .filter(Boolean)
    .map((pemBlock) => new crypto.X509Certificate(pemBlock).raw);
};

const appleRootCertificates = parseAppleRootCertificates(
  process.env.APPLE_ROOT_CERTIFICATES_PEM ||
    process.env.APPLE_ROOT_CERTIFICATES_B64,
);

const safeBase64UrlDecode = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
};

const isXcodePurchaseToken = (token?: string): boolean => {
  if (!token) {
    return false;
  }

  try {
    const header = token.split(".")[0];
    const decodedHeader = safeBase64UrlDecode(header);
    const headerObj = JSON.parse(decodedHeader);
    return Array.isArray(headerObj.x5c) && headerObj.x5c.length === 1;
  } catch {
    return false;
  }
};

const createVerifier = (env: Environment) =>
  new SignedDataVerifier(appleRootCertificates, true, env, bundleId);

const verifier =
  appleRootCertificates.length > 0 ? createVerifier(environment) : null;

const client = new AppStoreServerAPIClient(
  privateKey,
  keyId,
  issuerId,
  bundleId,
  environment,
);

const cors = corsLib.default({
  origin: true,
  optionsSuccessStatus: 200,
});

const createAppStoreConnectJwt = (): string => {
  const currentTime = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    kid: process.env.APPLE_STORE_CONNECT_KEY_ID || "",
    typ: "JWT",
  };
  const payload = {
    iss: issuerId,
    aud: "appstoreconnect-v1",
    iat: currentTime,
    exp: currentTime + 20 * 60,
    bid: bundleId,
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString(
    "base64url",
  );
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signer = crypto.createSign("sha256");
  signer.update(signingInput);
  signer.end();

  const signature = signer.sign(
    process.env.APPLE_STORE_CONNECT_PRIVATE_KEY || "",
  );

  logger.info(payload, "App Store Connect JWT payload");
  return `${signingInput}.${signature.toString("base64url")}`;
};

export const validatePurchaseFromAppStore = onRequest(
  { cors: true, invoker: "public" },
  (req, res) => {
    return cors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          return res.status(405).send("Method Not Allowed");
        }

        const headerKey = req.headers["x-api-key"] as string;

        if (headerKey !== process.env.API_KEY) {
          return res.status(401).send("Unathorized");
        }

        const { transactionId, purchaseToken } = req.body as {
          transactionId?: string;
          purchaseToken?: string;
        };

        if (!transactionId && !purchaseToken) {
          return res.status(400).json({
            isValid: false,
            message: "Missing transactionId or purchaseToken.",
          });
        }

        if (purchaseToken) {
          const tokenVerifier =
            isXcodePurchaseToken(purchaseToken) && !verifier
              ? createVerifier(Environment.XCODE)
              : isXcodePurchaseToken(purchaseToken)
                ? createVerifier(Environment.XCODE)
                : verifier;

          if (tokenVerifier) {
            try {
              const decodedTransaction =
                await tokenVerifier.verifyAndDecodeTransaction(purchaseToken);
              const bundleMatches = decodedTransaction.bundleId === bundleId;
              const productMatches =
                allowedProductIds.length === 0 ||
                (!!decodedTransaction.productId &&
                  allowedProductIds.includes(decodedTransaction.productId));
              const isValid = bundleMatches && productMatches;

              return res.status(isValid ? 200 : 404).json({
                isValid,
                validationSource: "purchaseToken",
                transactionId:
                  decodedTransaction.transactionId || transactionId,
                decodedTransaction: {
                  bundleId: decodedTransaction.bundleId,
                  productId: decodedTransaction.productId,
                  transactionId: decodedTransaction.transactionId,
                },
                purchaseData: purchaseToken,
              });
            } catch (error) {
              logger.error("Failed to verify App Store purchaseToken", error);
              return res.status(404).json({
                isValid: false,
                validationSource: "purchaseToken",
                transactionId,
                message: "Invalid or untrusted purchaseToken.",
              });
            }
          }
        }

        const transactionHistoryRequest: TransactionHistoryRequest = {
          sort: Order.ASCENDING,
          revoked: false,
          productTypes: [ProductType.AUTO_RENEWABLE],
        };
        let response: HistoryResponse | null = null;
        let signedTransactions: string[] = [];
        do {
          const revisionToken = response?.revision ?? null;

          response = await client.getTransactionHistory(
            transactionId || "",
            revisionToken,
            transactionHistoryRequest,
            GetTransactionHistoryVersion.V2,
          );
          if (response.signedTransactions) {
            signedTransactions = signedTransactions.concat(
              response.signedTransactions,
            );
          }
        } while (response.hasMore);

        const validatedTransactions: Array<{
          verified: boolean;
          bundleMatches: boolean;
          productMatches: boolean;
          decodedTransaction?: {
            bundleId?: string;
            productId?: string;
            transactionId?: string;
          };
        }> = [];

        for (const signedTransaction of signedTransactions) {
          if (!verifier) {
            validatedTransactions.push({
              verified: false,
              bundleMatches: false,
              productMatches: false,
            });
            continue;
          }

          try {
            const decodedTransaction =
              await verifier.verifyAndDecodeTransaction(signedTransaction);
            const bundleMatches = decodedTransaction.bundleId === bundleId;
            const productMatches =
              allowedProductIds.length === 0 ||
              (!!decodedTransaction.productId &&
                allowedProductIds.includes(decodedTransaction.productId));

            validatedTransactions.push({
              verified: true,
              bundleMatches,
              productMatches,
              decodedTransaction: {
                bundleId: decodedTransaction.bundleId,
                productId: decodedTransaction.productId,
                transactionId: decodedTransaction.transactionId,
              },
            });
          } catch (error) {
            logger.error(
              "Failed to verify App Store transaction signature",
              error,
            );
            validatedTransactions.push({
              verified: false,
              bundleMatches: false,
              productMatches: false,
            });
          }
        }

        const isValid = validatedTransactions.some(
          (item) => item.verified && item.bundleMatches && item.productMatches,
        );

        return res.status(isValid ? 200 : 404).json({
          isValid,
          validationSource: "transactionHistory",
          transactionId,
          verifiedTransactions: validatedTransactions,
          purchaseData: isValid ? JSON.stringify(signedTransactions) : null,
        });
      } catch (err) {
        logger.error("Failed purchase token validation:", err);
        return res.status(500).send("Internal Server Error");
      }
    });
  },
);

export const handleAppStoreSubscriptions = onRequest(
  { cors: true, invoker: "public" },
  (req, res) => {
    return cors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          return res.status(405).send("Method Not Allowed");
        }

        logger.info("Received App Store subscription notification:", req.body);

        return res.status(200).json({
          success: true,
          data: JSON.stringify(req.body),
        });
      } catch (err) {
        logger.error("Failed purchase token validation:", err);
        return res.status(500).send("Internal Server Error");
      }
    });
  },
);

export const sendAppStoreTestNotification = onRequest(
  { cors: true, invoker: "public" },
  (req, res) => {
    return cors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          return res.status(405).send("Method Not Allowed");
        }

        const jwt = createAppStoreConnectJwt();

        const appleResponse = await fetch(
          "https://api.storekit.apple.com/inApps/v1/notifications/test",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${jwt}`,
              "Content-Type": "application/json",
            },
          },
        );

        const responseBody = await appleResponse.text();

        logger.info("App Store test notification response", {
          status: appleResponse.status,
          body: responseBody,
        });

        return res.status(appleResponse.ok ? 200 : appleResponse.status).json({
          success: appleResponse.ok,
          status: appleResponse.status,
          data: responseBody,
        });
      } catch (err) {
        logger.error("Failed to send App Store test notification:", err);
        return res.status(500).send("Internal Server Error");
      }
    });
  },
);
