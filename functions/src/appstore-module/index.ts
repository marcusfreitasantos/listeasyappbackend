import { logger } from "firebase-functions/v2";
import * as corsLib from "cors";
import { onRequest } from "firebase-functions/v2/https";

import {
  AppStoreServerAPIClient,
  Environment,
  GetTransactionHistoryVersion,
  HistoryResponse,
  JWSTransactionDecodedPayload,
  Order,
  ProductType,
  TransactionHistoryRequest,
} from "@apple/app-store-server-library";
import {
  bundleId,
  isInvalidSignatureError,
  isRetryableVerificationError,
  verifyAndDecodeNotification,
  verifyAndDecodePurchaseToken,
  verifyAndDecodeRenewalInfo,
  verifyAndDecodeTransaction,
} from "./apple-verifier.js";
import { resolveSubscriptionEntitlement } from "./subscription-entitlement.js";
import { syncSubscriptionFromNotification } from "./sync-subscription.js";

const issuerId = process.env.APPLE_ISSUER_ID || "";
const keyId = process.env.APPLE_KEY_ID || "V6V256U3QR";
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
const privateKey = (process.env.APPLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const allowedProductIds = (process.env.APPLE_ALLOWED_PRODUCT_IDS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

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

const productIsAllowed = (productId?: string): boolean =>
  allowedProductIds.length === 0 ||
  (!!productId && allowedProductIds.includes(productId));

const decodedPurchaseSummary = (
  decodedTransaction: JWSTransactionDecodedPayload,
) => ({
  bundleId: decodedTransaction.bundleId,
  productId: decodedTransaction.productId,
  transactionId: decodedTransaction.transactionId,
  originalTransactionId: decodedTransaction.originalTransactionId,
  appAccountToken: decodedTransaction.appAccountToken,
  environment: decodedTransaction.environment,
});

const readSignedPayload = (body: unknown): string | undefined => {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const signedPayload = (body as { signedPayload?: unknown }).signedPayload;
  return typeof signedPayload === "string" && signedPayload.length > 0
    ? signedPayload
    : undefined;
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
          try {
            const verified = await verifyAndDecodePurchaseToken(purchaseToken);
            const decodedTransaction = verified.payload;
            const bundleMatches = decodedTransaction.bundleId === bundleId;
            const productMatches = productIsAllowed(
              decodedTransaction.productId,
            );
            const isValid = bundleMatches && productMatches;

            if (isValid || !transactionId) {
              return res.status(isValid ? 200 : 404).json({
                isValid,
                validationSource: "purchaseToken",
                transactionId:
                  decodedTransaction.transactionId || transactionId,
                decodedTransaction: decodedPurchaseSummary(decodedTransaction),
                purchaseData: purchaseToken,
              });
            }
          } catch (error) {
            logger.error("Failed to verify App Store purchaseToken", error);
            if (!transactionId) {
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
          decodedTransaction?: ReturnType<typeof decodedPurchaseSummary>;
        }> = [];

        for (const signedTransaction of signedTransactions) {
          try {
            const verified =
              await verifyAndDecodePurchaseToken(signedTransaction);
            const decodedTransaction = verified.payload;
            const bundleMatches = decodedTransaction.bundleId === bundleId;
            const productMatches = productIsAllowed(
              decodedTransaction.productId,
            );

            validatedTransactions.push({
              verified: true,
              bundleMatches,
              productMatches,
              decodedTransaction: decodedPurchaseSummary(decodedTransaction),
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

        const signedPayload = readSignedPayload(req.body);
        if (!signedPayload) {
          logger.error("App Store notification is missing signedPayload");
          return res.status(400).json({
            success: false,
            message: "Missing signedPayload.",
          });
        }

        const verifiedNotification =
          await verifyAndDecodeNotification(signedPayload);
        const notification = verifiedNotification.payload;
        const signedTransactionInfo =
          notification.data?.signedTransactionInfo;
        const signedRenewalInfo = notification.data?.signedRenewalInfo;
        const transaction = signedTransactionInfo
          ? await verifyAndDecodeTransaction(
              verifiedNotification.verifier,
              signedTransactionInfo,
            )
          : undefined;
        const renewal = signedRenewalInfo
          ? await verifyAndDecodeRenewalInfo(
              verifiedNotification.verifier,
              signedRenewalInfo,
            )
          : undefined;

        if (
          transaction?.productId &&
          !productIsAllowed(transaction.productId)
        ) {
          logger.info(
            "Ignoring App Store notification for a product that is not allowed",
            {
              notificationUUID: notification.notificationUUID,
              productId: transaction.productId,
            },
          );
          return res.status(200).json({ success: true, ignored: true });
        }

        const entitlement = resolveSubscriptionEntitlement(
          notification.notificationType,
          notification.subtype,
          notification.data?.status,
          transaction?.revocationDate,
        );
        const syncResult = await syncSubscriptionFromNotification({
          notification,
          transaction,
          renewal,
          entitlement,
        });

        logger.info("Processed App Store server notification", {
          notificationUUID: notification.notificationUUID,
          notificationType: notification.notificationType,
          subtype: notification.subtype,
          environment: verifiedNotification.environment,
          originalTransactionId: transaction?.originalTransactionId,
          appAccountToken: transaction?.appAccountToken,
          entitlement,
          duplicate: syncResult.duplicate,
          pendingUserLink: syncResult.pendingUserLink,
          updatedSubscriptionIds: syncResult.updatedSubscriptionIds,
        });

        if (syncResult.pendingUserLink) {
          return res.status(500).json({
            success: false,
            message: "Subscription is not linked to a user yet.",
          });
        }

        return res.status(200).json({
          success: true,
          duplicate: syncResult.duplicate,
          notificationType: notification.notificationType,
          updatedSubscriptionIds: syncResult.updatedSubscriptionIds,
        });
      } catch (err) {
        logger.error("Failed to process App Store server notification", err);
        if (isRetryableVerificationError(err)) {
          return res.status(500).send("Internal Server Error");
        }
        if (isInvalidSignatureError(err)) {
          return res.status(401).send("Invalid App Store signature");
        }
        return res.status(500).send("Internal Server Error");
      }
    });
  },
);
