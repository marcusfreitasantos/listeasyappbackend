import * as functions from "firebase-functions";
import { setGlobalOptions } from "firebase-functions/v2";

import { onMessagePublished } from "firebase-functions/v2/pubsub";
import * as admin from "firebase-admin";

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

exports.handlePlaySubscriptions = onMessagePublished(
  "subscriptions",
  (event) => {
    try {
      const json = event.data?.message?.json ?? event.data;
      functions.logger.info("✅ Pub/Sub message received", json);
    } catch (e) {
      functions.logger.error("PubSub message was not JSON", e);
    }
  }
);
