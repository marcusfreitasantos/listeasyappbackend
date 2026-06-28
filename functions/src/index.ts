import * as admin from "firebase-admin";
import { setGlobalOptions } from "firebase-functions/v2";

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

export * from "./user-module/index.js";
export * from "./playstore-module/index.js";
export * from "./appstore-module/index.js";
