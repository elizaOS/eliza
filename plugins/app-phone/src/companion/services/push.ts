import { Capacitor } from "@capacitor/core";
import {
  type PushNotificationSchema,
  PushNotifications,
  type Token,
} from "@capacitor/push-notifications";
import { logger } from "./logger";
import { decodePairingPayload, type PairingPayload } from "./session-client";

/**
 * APNs integration.
 *
 * On iOS native: requests notification permission, registers for APNs, and
 * listens for `pushNotificationReceived`. When a `intent.session.start` push
 * arrives, we decode its pairing payload and notify the caller so the app
 * can navigate to the RemoteSession view.
 *
 * On web: no-op — logged once. This lets `bun run build` + `bun run dev`
 * work in a browser without a simulator.
 */

export interface SessionStartIntent {
  kind: "session-start";
  payload: PairingPayload;
}

export type PushIntent = SessionStartIntent;

export interface RegisterPushOptions {
  onIntent(intent: PushIntent): void;
  onToken?(deviceToken: string): void;
  onError?(error: Error): void;
}

export interface RegisterPushHandle {
  unregister(): Promise<void>;
}

const INTENT_KEY = "intent";
const SESSION_START_INTENT = "session.start";

export async function registerPush(
  options: RegisterPushOptions,
): Promise<RegisterPushHandle> {
  if (!Capacitor.isNativePlatform()) {
    logger.info("[push] skipping registration; non-native platform", {
      platform: Capacitor.getPlatform(),
    });
    return { unregister: async () => {} };
  }

  const permission = await PushNotifications.requestPermissions();
  if (permission.receive !== "granted") {
    const error = new Error(
      `[push] APNs permission not granted: ${permission.receive}`,
    );
    logger.warn(error.message, { permission: permission.receive });
    options.onError?.(error);
    return { unregister: async () => {} };
  }

  const tokenHandle = await PushNotifications.addListener(
    "registration",
    (token: Token) => {
      logger.info("[push] APNs token received", {
        tokenLength: token.value.length,
      });
      options.onToken?.(token.value);
    },
  );

  const errorHandle = await PushNotifications.addListener(
    "registrationError",
    (err: { error: string }) => {
      const error = new Error(`[push] APNs registration failed: ${err.error}`);
      logger.error(error.message, {});
      options.onError?.(error);
    },
  );

  const receiveHandle = await PushNotifications.addListener(
    "pushNotificationReceived",
    (notification: PushNotificationSchema) => {
      handleNotification(notification, options);
    },
  );

  const actionHandle = await PushNotifications.addListener(
    "pushNotificationActionPerformed",
    (action: { notification: PushNotificationSchema }) => {
      handleNotification(action.notification, options);
    },
  );

  await PushNotifications.register();
  logger.info("[push] registered for APNs", {});

  return {
    unregister: async () => {
      await tokenHandle.remove();
      await errorHandle.remove();
      await receiveHandle.remove();
      await actionHandle.remove();
    },
  };
}

function handleNotification(
  notification: PushNotificationSchema,
  options: RegisterPushOptions,
): void {
  const data = notification.data ?? {};
  const intent = data[INTENT_KEY];
  if (intent !== SESSION_START_INTENT) {
    logger.debug("[push] non-session intent ignored", { intent });
    return;
  }
  const encoded = data.pairing;
  if (typeof encoded !== "string") {
    const error = new Error(
      "[push] session.start missing `pairing` payload field",
    );
    logger.error(error.message, {});
    options.onError?.(error);
    return;
  }
  try {
    const payload = decodePairingPayload(encoded);
    logger.info("[push] session.start intent received", {
      agentId: payload.agentId,
    });
    options.onIntent({ kind: "session-start", payload });
  } catch (cause) {
    const error =
      cause instanceof Error
        ? cause
        : new Error("[push] failed to decode session.start pairing payload");
    logger.error("[push] failed to decode session.start pairing payload", {
      error: error.message,
      encodedLength: encoded.length,
    });
    options.onError?.(error);
  }
}
