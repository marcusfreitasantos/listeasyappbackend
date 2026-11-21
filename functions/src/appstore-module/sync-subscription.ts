import * as admin from "firebase-admin";
import {
  JWSRenewalInfoDecodedPayload,
  JWSTransactionDecodedPayload,
  NotificationTypeV2,
  ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";
import { SubscriptionEntitlement } from "./subscription-entitlement.js";

const subscriptionsCollection = "Subscriptions";
const notificationsCollection = "AppStoreServerNotifications";

export type SubscriptionSyncResult = {
  duplicate: boolean;
  pendingUserLink: boolean;
  updatedSubscriptionIds: string[];
};

const getDb = () => admin.firestore();

const uniqueValues = (values: Array<string | undefined>): string[] => {
  const seen = new Set<string>();
  values.forEach((value) => {
    const normalized = value?.trim();
    if (normalized) {
      seen.add(normalized);
    }
  });
  return [...seen];
};

const withoutUndefined = (
  data: Record<string, unknown>,
): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );

export const syncSubscriptionFromNotification = async ({
  notification,
  transaction,
  renewal,
  entitlement,
}: {
  notification: ResponseBodyV2DecodedPayload;
  transaction?: JWSTransactionDecodedPayload;
  renewal?: JWSRenewalInfoDecodedPayload;
  entitlement: SubscriptionEntitlement;
}): Promise<SubscriptionSyncResult> => {
  const db = getDb();
  const notificationUUID = notification.notificationUUID;
  const appAccountToken =
    transaction?.appAccountToken || renewal?.appAccountToken;
  const originalTransactionId =
    transaction?.originalTransactionId || renewal?.originalTransactionId;
  const lookupValues = uniqueValues([
    appAccountToken,
    originalTransactionId,
    transaction?.transactionId,
  ]);
  const canMatchSubscription = lookupValues.length > 0;
  const isTestNotification =
    notification.notificationType === NotificationTypeV2.TEST;

  return db.runTransaction(async (firestoreTransaction) => {
    if (notificationUUID) {
      const notificationRef = db
        .collection(notificationsCollection)
        .doc(notificationUUID);
      const existing = await firestoreTransaction.get(notificationRef);
      if (existing.exists) {
        return {
          duplicate: true,
          pendingUserLink: false,
          updatedSubscriptionIds: [],
        };
      }
    }

    const matchedDocs = new Map<
      string,
      FirebaseFirestore.QueryDocumentSnapshot
    >();
    const lookups: Array<{ field: string; value?: string }> = [
      { field: "appAccountToken", value: appAccountToken },
      { field: "originalTransactionId", value: originalTransactionId },
      { field: "purchaseId", value: originalTransactionId },
      { field: "purchaseToken", value: originalTransactionId },
    ];

    for (const lookup of lookups) {
      const value = lookup.value?.trim();
      if (!value) {
        continue;
      }
      const snapshot = await firestoreTransaction.get(
        db
          .collection(subscriptionsCollection)
          .where(lookup.field, "==", value),
      );
      snapshot.docs.forEach((doc) => {
        matchedDocs.set(doc.id, doc);
      });
    }

    if (matchedDocs.size === 0 && canMatchSubscription && !isTestNotification) {
      return {
        duplicate: false,
        pendingUserLink: true,
        updatedSubscriptionIds: [],
      };
    }

    const update = withoutUndefined({
      ...(entitlement === "unchanged" ? {} : { status: entitlement }),
      ...(transaction?.productId ? { productId: transaction.productId } : {}),
      ...(appAccountToken ? { appAccountToken } : {}),
      ...(originalTransactionId ? { originalTransactionId } : {}),
      latestTransactionId: transaction?.transactionId ?? null,
      expiresAt: transaction?.expiresDate
        ? new Date(transaction.expiresDate)
        : null,
      autoRenewStatus: renewal?.autoRenewStatus ?? null,
      autoRenewProductId: renewal?.autoRenewProductId ?? null,
      appleEnvironment:
        transaction?.environment ||
        renewal?.environment ||
        notification.data?.environment ||
        null,
      appleSubscriptionStatus: notification.data?.status ?? null,
      lastNotificationType: notification.notificationType ?? null,
      lastNotificationSubtype: notification.subtype ?? null,
      lastNotificationUUID: notificationUUID ?? null,
      subscriptionUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const updatedSubscriptionIds: string[] = [];
    matchedDocs.forEach((doc) => {
      firestoreTransaction.update(
        doc.ref,
        update as FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData>,
      );
      updatedSubscriptionIds.push(doc.id);
    });

    const notificationRecord = withoutUndefined({
      notificationType: notification.notificationType ?? null,
      subtype: notification.subtype ?? null,
      environment: notification.data?.environment ?? null,
      bundleId: notification.data?.bundleId ?? transaction?.bundleId ?? null,
      productId: transaction?.productId ?? null,
      appAccountToken: appAccountToken ?? null,
      originalTransactionId: originalTransactionId ?? null,
      transactionId: transaction?.transactionId ?? null,
      entitlement,
      lookupValues,
      updatedSubscriptionIds,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const notificationRef = notificationUUID
      ? db.collection(notificationsCollection).doc(notificationUUID)
      : db.collection(notificationsCollection).doc();
    firestoreTransaction.set(notificationRef, notificationRecord);

    return {
      duplicate: false,
      pendingUserLink: false,
      updatedSubscriptionIds,
    };
  });
};
