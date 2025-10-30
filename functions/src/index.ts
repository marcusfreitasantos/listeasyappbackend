import * as functions from "firebase-functions";
import { setGlobalOptions } from "firebase-functions/v2";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import * as admin from "firebase-admin";
const db = admin.firestore();

type SubscriptionNotification = {
  version: string;
  notificationType: number;
  purchaseToken: string;
};

type SubscriptionFirestoreDocType = {
  id: string;
  productId: string;
  userId: string;
  userName: string;
  userEmail: string;
  status: "active" | "inactive";
};

const subscriptionNotificationTypes = [
  { 1: "SUBSCRIPTION_RECOVERED" },
  { 2: "SUBSCRIPTION_RENEWED" },
  { 3: "SUBSCRIPTION_CANCELED" },
  { 4: "SUBSCRIPTION_PURCHASED" },
  { 5: "SUBSCRIPTION_ON_HOLD" },
  { 6: "SUBSCRIPTION_IN_GRACE_PERIOD" },
  { 7: "SUBSCRIPTION_RESTARTED" },
  { 8: "SUBSCRIPTION_PRICE_CHANGE_CONFIRMED" },
  { 9: "SUBSCRIPTION_DEFERRED" },
  { 10: "SUBSCRIPTION_PAUSED" },
  { 11: "SUBSCRIPTION_PAUSE_SCHEDULE_CHANGED" },
  { 12: "SUBSCRIPTION_REVOKED" },
  { 13: "SUBSCRIPTION_EXPIRED" },
  { 19: "SUBSCRIPTION_PRICE_CHANGE_UPDATED" },
  { 20: "SUBSCRIPTION_PENDING_PURCHASE_CANCELED" },
  { 22: "SUBSCRIPTION_PRICE_STEP_UP_CONSENT_UPDATED" },
];

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const updateSubscriptionStatusInFirestore = async (
  subscriptionId: string,
  subscriptionStatus: string
): Promise<SubscriptionFirestoreDocType | object> => {
  const subscriptionsCollection = db.collection("Subscriptions");
  const subscriptionDoc = await subscriptionsCollection
    .where("stripeSubscriptionId", "==", subscriptionId)
    .get();

  if (subscriptionDoc.empty) {
    return {};
  }

  let subscriptionData: SubscriptionFirestoreDocType | object = {};

  subscriptionDoc.forEach((doc) => {
    subscriptionsCollection.doc(doc.id).update({
      stripeSubscriptionStatus: subscriptionStatus,
    });
    subscriptionData = {
      ...doc.data(),
      stripeSubscriptionStatus: subscriptionStatus,
    };
  });

  return subscriptionData;
};

const setSubscriptionStatusBasedOnNotificationType = (
  notificationType: number
) => {
  const activeStatus = [1, 2, 4, 6, 7];

  if (activeStatus.includes(notificationType)) {
    return "active";
  } else {
    return "inactive";
  }
};

exports.handlePlaySubscriptions = onMessagePublished(
  "subscriptions",
  async (event) => {
    try {
      const json = event.data?.message?.json ?? event.data;

      functions.logger.info("✅ Pub/Sub message received", json);

      let subscriptionUpdatedStatus = "";
      let subscriptionId = "";

      if (!json.subscriptionNotification)
        throw new Error("Invalid subscription!");

      const subscriptionNotification: SubscriptionNotification =
        json.subscriptionNotification;

      const isValidNotificationType =
        subscriptionNotificationTypes[
          subscriptionNotification.notificationType
        ] ?? null;

      if (!isValidNotificationType)
        throw new Error(
          `This notification type: [${subscriptionNotification.notificationType}] is not supported `
        );

      subscriptionUpdatedStatus = setSubscriptionStatusBasedOnNotificationType(
        subscriptionNotification.notificationType
      );

      const updatedSubscription = (await updateSubscriptionStatusInFirestore(
        subscriptionId,
        subscriptionUpdatedStatus
      )) as SubscriptionFirestoreDocType;

      if (!updatedSubscription.id) throw new Error("Subscription not updated.");

      functions.logger.info(
        "Subscription updated successfully.",
        JSON.stringify(updatedSubscription)
      );
    } catch (e) {
      functions.logger.error("PubSub message was not processed!", e);
    }
  }
);
