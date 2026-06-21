import * as functions from "firebase-functions";
import { setGlobalOptions } from "firebase-functions/v2";
import { onMessagePublished } from "firebase-functions/v2/pubsub";
import * as admin from "firebase-admin";
import * as corsLib from "cors";
import { google } from "googleapis";
import { FirebaseAuthError } from "firebase-admin/auth";

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

const db = admin.firestore();
const cors = corsLib({
  origin: true,
  optionsSuccessStatus: 200,
});

// GOOGLE PLAY SETUP - START
const playDeveloperApi = google.androidpublisher("v3");
const packageName = "com.penpack.listeasy";

const keyBase64 = process.env.GOOGLE_CLOUD_SERVICE_KEY;

const keyJson = keyBase64
  ? JSON.parse(Buffer.from(keyBase64, "base64").toString("utf-8"))
  : null;

const auth = new google.auth.GoogleAuth({
  credentials: keyJson,
  scopes: ["https://www.googleapis.com/auth/androidpublisher"],
});

google.options({ auth });
// GOOGLE PLAY SETUP - END

type SubscriptionNotification = {
  version: string;
  notificationType: number;
  purchaseToken: string;
  subscriptionId: string;
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

const activeStatus = [2, 4, 6, 7, 13, 19];

const getCollectionData = async (
  collection: FirebaseFirestore.CollectionReference,
  key: string,
  value: any,
): Promise<FirebaseFirestore.QuerySnapshot> => {
  try {
    const collectionDoc = await collection.where(key, "==", value).get();

    return collectionDoc;
  } catch (err) {
    throw new Error("Error checking collection data: " + err);
  }
};

const updateSubscriptionStatusInFirestore = async (
  purchaseToken: string,
  subscriptionStatus: string,
): Promise<SubscriptionFirestoreDocType | object> => {
  const subscriptionsCollection = db.collection("Subscriptions");
  const subscriptionDoc = await getCollectionData(
    subscriptionsCollection,
    "purchaseToken",
    purchaseToken,
  );

  if (subscriptionDoc.empty) {
    return {};
  }

  let subscriptionData: SubscriptionFirestoreDocType | object = {};

  subscriptionDoc.forEach((doc) => {
    subscriptionsCollection.doc(doc.id).update({
      status: subscriptionStatus,
    });
    subscriptionData = {
      ...doc.data(),
      status: subscriptionStatus,
    };
  });

  return subscriptionData;
};

const setSubscriptionStatusBasedOnNotificationType = (
  notificationType: number,
) => {
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
      let subscriptionUpdatedStatus = "";
      const json = event.data?.message?.json ?? event.data;

      functions.logger.info("Pub/Sub message received", json);

      const subscriptionNotification: SubscriptionNotification =
        json.subscriptionNotification;

      if (!subscriptionNotification) {
        throw new Error("Invalid subscription!");
      }

      const subscriptionType = subscriptionNotification.notificationType;

      const isValidNotificationType =
        subscriptionNotificationTypes[subscriptionType];

      if (!isValidNotificationType) {
        throw new Error(
          `This notification type: [${subscriptionType}] is not supported `,
        );
      }

      if (subscriptionType === 3 || subscriptionType === 7) {
        const purchaseToken = subscriptionNotification.purchaseToken;

        if (!purchaseToken) throw new Error("Invalid purchaseToken.");

        subscriptionUpdatedStatus =
          setSubscriptionStatusBasedOnNotificationType(
            subscriptionNotification.notificationType,
          );

        const updatedSubscription = (await updateSubscriptionStatusInFirestore(
          purchaseToken,
          subscriptionUpdatedStatus,
        )) as SubscriptionFirestoreDocType;

        if (!updatedSubscription.id) {
          throw new Error("Subscription not updated.");
        }

        functions.logger.info(
          "Subscription updated successfully.",
          JSON.stringify(updatedSubscription),
        );
      }
    } catch (e) {
      functions.logger.error("PubSub message was not processed!", e);
    }
  },
);

exports.validatePurchaseTokenFromGooglePlay = functions.https.onRequest(
  (req, res) => {
    return cors(req, res, async () => {
      try {
        if (req.method !== "POST") {
          return res.status(405).send("Method Not Allowed");
        }

        const { purchaseToken } = req.body as {
          purchaseToken: string;
        };

        if (!purchaseToken) {
          return res.status(400).send("Missing purchaseToken.");
        }

        const result = await playDeveloperApi.purchases.subscriptionsv2.get({
          token: purchaseToken,
          packageName,
        });

        const purchaseData = result.data;

        const isValid =
          purchaseData?.subscriptionState === "SUBSCRIPTION_STATE_ACTIVE" &&
          !purchaseData?.canceledStateContext;

        return res.status(200).json({
          isValid,
          purchaseData,
        });
      } catch (err) {
        console.error("Failed purchase token validation:", err);
        return res.status(500).send("Internal Server Error");
      }
    });
  },
);

exports.getUserByEmailInFirebaseAuth = functions.https.onRequest((req, res) => {
  return cors(req, res, async () => {
    try {
      if (req.method !== "GET") {
        return res.status(405).send("Method Not Allowed");
      }

      const headerKey = req.headers["x-api-key"] as string;

      if (headerKey !== process.env.API_KEY) {
        return res.status(401).send("Unathorized");
      }

      const { user_email } = req.query as {
        user_email: string;
      };
      const user = await admin.auth().getUserByEmail(user_email);

      return res.status(200).json({
        uid: user.uid,
        displayName: user.displayName,
        email: user.email,
      });
    } catch (err) {
      console.log(err);
      if (
        err instanceof FirebaseAuthError &&
        err.code === "auth/user-not-found"
      ) {
        return res
          .status(404)
          .send(
            "There is no user record corresponding to the provided identifier.",
          );
      }
      return res.status(500).send("Internal Server Error");
    }
  });
});

const removeAllUserListsFromFirestore = async (
  userId: string,
): Promise<{ status: string; message: string }> => {
  const listsCollection: FirebaseFirestore.CollectionReference =
    db.collection("Lists");
  const listsCollectionDoc: FirebaseFirestore.QuerySnapshot =
    await getCollectionData(listsCollection, "authorId", userId);

  if (listsCollectionDoc.empty) {
    return {
      status: "error",
      message: `No lists found for user: ${userId}`,
    };
  }

  await Promise.all(
    listsCollectionDoc.docs.map(async (doc) => {
      await listsCollection.doc(doc.id).delete();
    }),
  );

  return {
    status: "success",
    message: `All lists removed for user: ${userId}`,
  };
};

const removeAllUserInvitesFromFirestore = async (
  userId: string,
): Promise<{ status: string; message: string }> => {
  const invitesCollection: FirebaseFirestore.CollectionReference =
    db.collection("Invites");
  const invitesCollectionDoc: FirebaseFirestore.QuerySnapshot =
    await getCollectionData(invitesCollection, "referralUserId", userId);

  if (invitesCollectionDoc.empty) {
    return {
      status: "error",
      message: `No invites found for user: ${userId}`,
    };
  }

  await Promise.all(
    invitesCollectionDoc.docs.map(async (doc) => {
      await invitesCollection.doc(doc.id).delete();
    }),
  );

  return {
    status: "success",
    message: `All invites removed for user: ${userId}`,
  };
};

exports.deleteUserData = functions.https.onRequest((req, res) => {
  return cors(req, res, async () => {
    try {
      if (req.method !== "POST") {
        return res.status(405).send("Method Not Allowed");
      }

      const headerKey = req.headers["x-api-key"] as string;

      if (headerKey !== process.env.API_KEY) {
        return res.status(401).send("Unathorized");
      }

      const { userId, purchaseToken } = req.body as {
        userId: string;
        purchaseToken: string;
      };

      //GET USER
      const user = await admin.auth().getUser(userId);

      //DEACTIVATE SUBSCRIPTION
      const updatedSubscription: SubscriptionFirestoreDocType | object = ({} =
        await updateSubscriptionStatusInFirestore(purchaseToken, "inactive"));

      //REMOVE ALL LISTS
      await removeAllUserListsFromFirestore(userId);

      //REMOVE ALL INVITES
      await removeAllUserInvitesFromFirestore(userId);

      //REMOVE USER ACCOUNT

      return res.status(200).json({
        uid: user.uid,
        displayName: user.displayName,
        email: user.email,
        updatedSubscription,
        message: "User data deletion request received.",
      });
    } catch (err) {
      console.log(err);
      if (
        err instanceof FirebaseAuthError &&
        err.code === "auth/user-not-found"
      ) {
        return res
          .status(404)
          .send(
            "There is no user record corresponding to the provided identifier.",
          );
      }
      return res.status(500).send("Internal Server Error");
    }
  });
});
