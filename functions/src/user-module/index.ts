import * as admin from "firebase-admin";
import * as corsLib from "cors";
import { FirebaseAuthError } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";

const db = admin.firestore();
const cors = corsLib.default({
  origin: true,
  optionsSuccessStatus: 200,
});

type SubscriptionFirestoreDocType = {
  id: string;
  productId: string;
  userId: string;
  userName: string;
  userEmail: string;
  status: "active" | "inactive";
};

const getCollectionData = async (
  collection: FirebaseFirestore.CollectionReference,
  key: string,
  value: string,
): Promise<FirebaseFirestore.QuerySnapshot> => {
  try {
    const collectionDoc = await collection.where(key, "==", value).get();

    return collectionDoc;
  } catch (err) {
    throw new Error("Error checking collection data: " + err);
  }
};

export const updateSubscriptionStatusInFirestore = async (
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

export const getUserByEmailInFirebaseAuth = onRequest(
  { cors: true, invoker: "public" },
  (req, res) => {
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
        logger.error(err);
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
  },
);

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

export const deleteUserData = onRequest(
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

        const { userId, purchaseToken } = req.body as {
          userId: string;
          purchaseToken: string;
        };

        const user = await admin.auth().getUser(userId);

        const updatedSubscription: SubscriptionFirestoreDocType | object =
          await updateSubscriptionStatusInFirestore(purchaseToken, "inactive");

        await removeAllUserListsFromFirestore(userId);

        await removeAllUserInvitesFromFirestore(userId);

        await admin.auth().deleteUser(userId);

        return res.status(200).json({
          uid: user.uid,
          displayName: user.displayName,
          email: user.email,
          updatedSubscription,
          message: "User data deletion request received.",
        });
      } catch (err) {
        logger.error(err);
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
  },
);
