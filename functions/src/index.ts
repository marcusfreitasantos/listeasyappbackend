import * as admin from "firebase-admin";
import { setGlobalOptions } from "firebase-functions/v2";

try {
  admin.initializeApp();
} catch (error) {
  console.warn("Firebase admin already initialized", error);
}

setGlobalOptions({ maxInstances: 20 });

export * from "./user-module/index.js";
export * from "./playstore-module/index.js";
export * from "./appstore-module/index.js";
