import * as fs from "node:fs";
import * as path from "node:path";

import * as admin from "firebase-admin";
import * as corsLib from "cors";
import { Expo, ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import { logger } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";

const cors = corsLib.default({
  origin: true,
  optionsSuccessStatus: 200,
});

const db = admin.firestore();
const expo = new Expo();

type SendNotificationRequest = {
  userUid?: string;
  userUids?: string[];
};

type DefaultNotificationVariant = {
  title: string;
  message: string;
  language: string;
};

type DefaultNotificationMessageSet = DefaultNotificationVariant[];

type TargetPushToken = {
  pushToken: string;
  userUid?: string;
  userLanguage?: string;
};

const uniqueStrings = (values: unknown[]): string[] =>
  Array.from(
    new Set(
      values.filter((value): value is string => typeof value === "string"),
    ),
  );

const getTargetUserUids = (requestData: SendNotificationRequest): string[] =>
  uniqueStrings([
    requestData.userUid,
    ...(Array.isArray(requestData.userUids) ? requestData.userUids : []),
  ]);

const getDefaultNotificationMessages = (): DefaultNotificationMessageSet[] => {
  const candidatePaths = [
    path.join(__dirname, "default-messages.json"),
    path.join(__dirname, "..", "notification-module", "default-messages.json"),
    path.join(
      process.cwd(),
      "src",
      "notification-module",
      "default-messages.json",
    ),
    path.join(
      process.cwd(),
      "lib",
      "notification-module",
      "default-messages.json",
    ),
  ];

  for (const candidatePath of candidatePaths) {
    if (fs.existsSync(candidatePath)) {
      const fileContent = fs.readFileSync(candidatePath, "utf8");
      return JSON.parse(fileContent) as DefaultNotificationMessageSet[];
    }
  }

  throw new Error("default-messages.json was not found.");
};

const DEFAULT_NOTIFICATION_MESSAGES = getDefaultNotificationMessages();

const normalizeUserLanguage = (language?: string): string => {
  const normalized = (language ?? "en").trim().toLowerCase();

  if (!normalized) {
    return "en";
  }

  if (normalized.startsWith("pt")) {
    return "pt-br";
  }

  if (normalized.startsWith("en")) {
    return "en";
  }

  return "en";
};

const getPreferredMessageFromGroup = (
  variants: DefaultNotificationMessageSet,
  userLanguage?: string,
): DefaultNotificationVariant => {
  const normalizedUserLanguage = normalizeUserLanguage(userLanguage);
  const exactMatch = variants.find(
    (variant) =>
      normalizeUserLanguage(variant.language) === normalizedUserLanguage,
  );

  if (exactMatch) {
    return exactMatch;
  }

  const englishFallback = variants.find(
    (variant) => normalizeUserLanguage(variant.language) === "en",
  );

  return (
    englishFallback ??
    variants[0] ?? {
      title: "Time to organize your shopping",
      message:
        "Have you checked your list for this week? Open List Easy and organize your shopping.",
      language: "en",
    }
  );
};

const getRandomDefaultMessage = (
  userLanguage?: string,
): { title: string; message: string } => {
  const randomIndex = Math.floor(
    Math.random() * DEFAULT_NOTIFICATION_MESSAGES.length,
  );
  const selectedMessage = DEFAULT_NOTIFICATION_MESSAGES[randomIndex];
  const preferredMessage = getPreferredMessageFromGroup(
    selectedMessage,
    userLanguage,
  );

  return {
    title: preferredMessage.title,
    message: preferredMessage.message,
  };
};

const getExpoPushTokenTargetsFromUsers = async (
  userUids: string[],
): Promise<TargetPushToken[]> => {
  const tokenGroups = await Promise.all(
    userUids.map(async (userUid) => {
      const userDoc = await db.collection("Users").doc(userUid).get();
      const userData = userDoc.data() ?? {};
      const singleToken = userData.expoPushToken;
      const tokenList = Array.isArray(userData.expoPushTokens)
        ? userData.expoPushTokens
        : [];

      return uniqueStrings([singleToken, ...tokenList]).map((pushToken) => ({
        pushToken,
        userUid,
        userLanguage: userData.userLanguage,
      }));
    }),
  );

  return tokenGroups.flat();
};

const getExpoPushTokenTargetsFromAllUsers = async (): Promise<
  TargetPushToken[]
> => {
  const usersSnapshot = await db.collection("Users").get();

  return usersSnapshot.docs.flatMap((userDoc) => {
    const userData = userDoc.data() ?? {};
    const singleToken = userData.expoPushToken;
    const tokenList = Array.isArray(userData.expoPushTokens)
      ? userData.expoPushTokens
      : [];

    return uniqueStrings([singleToken, ...tokenList]).map((pushToken) => ({
      pushToken,
      userUid: userDoc.id,
      userLanguage: userData.userLanguage,
    }));
  });
};

const buildPushMessages = (targets: TargetPushToken[]): ExpoPushMessage[] => {
  const invalidPushTokens = targets.filter(
    ({ pushToken }) => !Expo.isExpoPushToken(pushToken),
  );

  if (invalidPushTokens.length) {
    throw new Error(
      `Invalid Expo push token(s): ${invalidPushTokens
        .map(({ pushToken }) => pushToken)
        .join(", ")}`,
    );
  }

  return targets.map(({ pushToken, userUid, userLanguage }) => {
    const { title, message } = getRandomDefaultMessage(userLanguage);

    return {
      to: pushToken,
      title,
      body: message,
      sound: "default",
      priority: "high",
      channelId: "default",
      data: {
        userUid,
        notificationTitle: title,
        notificationMessageContent: message,
      },
    };
  });
};

const sendExpoPushMessages = async (
  messages: ExpoPushMessage[],
): Promise<ExpoPushTicket[]> => {
  const chunks = expo.chunkPushNotifications(messages);
  const ticketGroups = await Promise.all(
    chunks.map((chunk) => expo.sendPushNotificationsAsync(chunk)),
  );

  return ticketGroups.flat();
};

export const sendNotification = onRequest(
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

        const requestData = req.body as SendNotificationRequest;
        const targetUserUids = getTargetUserUids(requestData);
        logger.info("targetUserUids", JSON.stringify(targetUserUids));

        const userTargets =
          targetUserUids.length > 0
            ? await getExpoPushTokenTargetsFromUsers(targetUserUids)
            : await getExpoPushTokenTargetsFromAllUsers();

        const targetsByPushToken = new Map(
          userTargets.map((target) => [target.pushToken, target]),
        );
        const targets = Array.from(targetsByPushToken.values());

        if (!targets.length) {
          return res.status(400).send("Missing target push token or user uid.");
        }

        const messages = buildPushMessages(targets);
        const tickets = await sendExpoPushMessages(messages);
        const successfulTickets = tickets.filter(
          (ticket) => ticket.status === "ok",
        );
        const failedTickets = tickets.filter(
          (ticket) => ticket.status !== "ok",
        );

        if (failedTickets.length) {
          logger.error(
            "Some Expo push notifications failed:",
            JSON.stringify(failedTickets),
          );
        }

        return res.status(failedTickets.length ? 400 : 200).json({
          success: failedTickets.length === 0,
          sent: successfulTickets.length,
          failed: failedTickets.length,
          tickets,
        });
      } catch (err) {
        logger.error("Failed to send notification:", err);

        if (err instanceof Error) {
          return res.status(400).send(err.message);
        }

        return res.status(500).send("Internal Server Error");
      }
    });
  },
);
