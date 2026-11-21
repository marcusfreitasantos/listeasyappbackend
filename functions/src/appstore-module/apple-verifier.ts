import { logger } from "firebase-functions/v2";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  Environment,
  JWSRenewalInfoDecodedPayload,
  JWSTransactionDecodedPayload,
  ResponseBodyV2DecodedPayload,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from "@apple/app-store-server-library";

export const bundleId = "com.penpack.listeasy";

const appAppleId = Number(process.env.APPLE_APP_APPLE_ID || "6779047527");

const bundledCertificateNames = [
  "AppleIncRootCertificate.cer",
  "AppleRootCA-G2.cer",
  "AppleRootCA-G3.cer",
];

const safeBase64UrlDecode = (value: string): string => {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding =
    normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
};

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

const loadBundledRootCertificates = (): Buffer[] => {
  const directories = [
    path.join(__dirname, "certs"),
    path.join(__dirname, "../../src/appstore-module/certs"),
  ];

  return bundledCertificateNames.flatMap((fileName) => {
    const filePath = directories
      .map((directory) => path.join(directory, fileName))
      .find((candidate) => fs.existsSync(candidate));

    if (!filePath) {
      logger.error(`Missing Apple root certificate ${fileName}`);
      return [];
    }

    return [fs.readFileSync(filePath)];
  });
};

const dedupeCertificates = (certificates: Buffer[]): Buffer[] => {
  const seen = new Set<string>();
  return certificates.filter((certificate) => {
    const fingerprint = certificate.toString("base64");
    if (seen.has(fingerprint)) {
      return false;
    }
    seen.add(fingerprint);
    return true;
  });
};

export const appleRootCertificates = dedupeCertificates([
  ...loadBundledRootCertificates(),
  ...parseAppleRootCertificates(
    process.env.APPLE_ROOT_CERTIFICATES_PEM ||
      process.env.APPLE_ROOT_CERTIFICATES_B64,
  ),
]);

const verifiers = new Map<Environment, SignedDataVerifier>();

const registerVerifier = (environment: Environment) => {
  if (appleRootCertificates.length === 0) {
    return;
  }

  if (
    environment === Environment.PRODUCTION &&
    !Number.isInteger(appAppleId)
  ) {
    logger.error(
      "APPLE_APP_APPLE_ID must be set before production notifications can be verified",
    );
    return;
  }

  verifiers.set(
    environment,
    new SignedDataVerifier(
      appleRootCertificates,
      environment !== Environment.XCODE,
      environment,
      bundleId,
      environment === Environment.PRODUCTION ? appAppleId : undefined,
    ),
  );
};

registerVerifier(Environment.PRODUCTION);
registerVerifier(Environment.SANDBOX);
registerVerifier(Environment.XCODE);
registerVerifier(Environment.LOCAL_TESTING);

const readUnverifiedPayload = (jws: string): Record<string, unknown> | null => {
  try {
    const payload = jws.split(".")[1];
    if (!payload) {
      return null;
    }
    const decoded = JSON.parse(safeBase64UrlDecode(payload)) as unknown;
    if (!decoded || typeof decoded !== "object") {
      return null;
    }
    return decoded as Record<string, unknown>;
  } catch {
    return null;
  }
};

const environmentFromClaim = (value: unknown): Environment | null => {
  if (value === Environment.PRODUCTION) return Environment.PRODUCTION;
  if (value === Environment.SANDBOX) return Environment.SANDBOX;
  if (value === Environment.XCODE) return Environment.XCODE;
  if (value === Environment.LOCAL_TESTING) return Environment.LOCAL_TESTING;
  return null;
};

const claimedEnvironment = (jws: string): Environment | null => {
  const payload = readUnverifiedPayload(jws);
  if (!payload) {
    return null;
  }

  const direct = environmentFromClaim(payload.environment);
  if (direct) {
    return direct;
  }

  const data = payload.data;
  if (!data || typeof data !== "object") {
    return null;
  }

  return environmentFromClaim(
    (data as Record<string, unknown>).environment,
  );
};

export const isXcodePurchaseToken = (token?: string): boolean => {
  if (!token) {
    return false;
  }

  try {
    const header = token.split(".")[0];
    const decodedHeader = safeBase64UrlDecode(header);
    const headerObj = JSON.parse(decodedHeader) as { x5c?: unknown };
    return Array.isArray(headerObj.x5c) && headerObj.x5c.length === 1;
  } catch {
    return false;
  }
};

const verifierOrder = (jws: string): Environment[] => {
  if (isXcodePurchaseToken(jws)) {
    return [Environment.XCODE];
  }

  const claimed = claimedEnvironment(jws);
  if (claimed) {
    return [claimed];
  }

  return [Environment.PRODUCTION, Environment.SANDBOX];
};

const verifyWithMatchingEnvironment = async <T>(
  jws: string,
  verify: (verifier: SignedDataVerifier) => Promise<T>,
): Promise<{ environment: Environment; payload: T; verifier: SignedDataVerifier }> => {
  if (verifiers.size === 0) {
    throw new Error("Apple root certificates are not configured");
  }

  const order = verifierOrder(jws);
  let lastError: unknown;

  for (const environment of order) {
    const verifier = verifiers.get(environment);
    if (!verifier) {
      continue;
    }

    try {
      const payload = await verify(verifier);
      return { environment, payload, verifier };
    } catch (error) {
      lastError = error;
      const canTryNextEnvironment =
        order.length > 1 &&
        error instanceof VerificationException &&
        error.status === VerificationStatus.INVALID_ENVIRONMENT;
      if (!canTryNextEnvironment) {
        throw error;
      }
    }
  }

  throw lastError ?? new Error("No App Store verifier is configured");
};

export const verifyAndDecodePurchaseToken = (purchaseToken: string) =>
  verifyWithMatchingEnvironment(purchaseToken, (verifier) =>
    verifier.verifyAndDecodeTransaction(purchaseToken),
  );

export const verifyAndDecodeNotification = (signedPayload: string) =>
  verifyWithMatchingEnvironment(signedPayload, (verifier) =>
    verifier.verifyAndDecodeNotification(signedPayload),
  );

export const verifyAndDecodeTransaction = (
  verifier: SignedDataVerifier,
  signedTransactionInfo: string,
): Promise<JWSTransactionDecodedPayload> =>
  verifier.verifyAndDecodeTransaction(signedTransactionInfo);

export const verifyAndDecodeRenewalInfo = (
  verifier: SignedDataVerifier,
  signedRenewalInfo: string,
): Promise<JWSRenewalInfoDecodedPayload> =>
  verifier.verifyAndDecodeRenewalInfo(signedRenewalInfo);

export type VerifiedNotification = {
  environment: Environment;
  payload: ResponseBodyV2DecodedPayload;
  verifier: SignedDataVerifier;
};

export const isRetryableVerificationError = (error: unknown): boolean =>
  error instanceof VerificationException &&
  error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE;

export const isInvalidSignatureError = (error: unknown): boolean =>
  error instanceof VerificationException &&
  error.status !== VerificationStatus.RETRYABLE_VERIFICATION_FAILURE;
