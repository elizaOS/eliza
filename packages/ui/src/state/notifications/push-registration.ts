/**
 * Device remote-push registration: acquires the OS push token (APNs on iOS, FCM
 * on Android) from `@capacitor/push-notifications` and hands it to the server so
 * a backgrounded/killed device can be reached (`POST /api/notifications/push-tokens`).
 * This is the client trigger the server's push-token routes had been missing —
 * without it `PushTokenRegistry.list()` is always empty and the whole APNs/FCM
 * stack is a dead pipeline.
 *
 * Flow (native only — a no-op on web/desktop where the plugin is absent):
 *   1. Gate on a *granted* notification permission. Registration never prompts;
 *      the ask is primed elsewhere (the onboarding permission modal). We only
 *      register once the user has already said yes, so an unregistered token is
 *      the honest signal "permission not granted", not a swallowed failure.
 *   2. Attach the `registration` listener, then call `register()`. The OS mints
 *      the token asynchronously and fires the listener; we POST it. iOS routes
 *      the APNs token through the AppDelegate → Capacitor bridge; Android reads
 *      the FCM token directly.
 *   3. Attach `pushNotificationActionPerformed` so a tapped push deep-links via
 *      the same scheme-checked `navigateDeepLink` the in-app center uses.
 *
 * The listeners live for the app's lifetime; `initPushRegistration` is
 * idempotent so remounting the shell (or re-calling after a permission grant)
 * does not double-register.
 */

import { logger } from "@elizaos/logger";
import { client } from "../../api/client";
import {
  getPushNotificationsPlugin,
  type PushActionPerformed,
  type PushNotificationsPluginLike,
  type PushRegistrationError,
  type PushRegistrationToken,
} from "../../bridge/native-plugins";
import {
  type FrontendPlatform,
  getFrontendPlatform,
} from "../../platform/platform-guards";
import { navigateDeepLink } from "./navigate-deep-link";

/**
 * Injectable boundaries. The Capacitor push plugin, the platform detector, the
 * HTTP client, and the deep-link navigator are the four seams to the outside
 * world; injecting them lets the registration flow be driven end-to-end in a
 * test without a real device, while production wires the real singletons.
 */
export interface PushRegistrationDeps {
  getPlatform: () => FrontendPlatform;
  getPlugin: () => PushNotificationsPluginLike;
  registerToken: (
    platform: "ios" | "android",
    token: string,
  ) => Promise<unknown>;
  unregisterToken: (token: string) => Promise<unknown>;
  navigate: (deepLink: string) => void;
}

const defaultDeps: PushRegistrationDeps = {
  getPlatform: getFrontendPlatform,
  getPlugin: getPushNotificationsPlugin,
  registerToken: (platform, token) => client.registerPushToken(platform, token),
  unregisterToken: (token) => client.unregisterPushToken(token),
  navigate: navigateDeepLink,
};

let startPromise: Promise<void> | null = null;
let listenerPromise: Promise<void> | null = null;
/** The most recent token we POSTed, so a re-fired `registration` is a no-op. */
let registeredToken: string | null = null;

/** Only the native mobile platforms carry a remote-push transport. */
function pushPlatform(platform: FrontendPlatform): "ios" | "android" | null {
  return platform === "ios" || platform === "android" ? platform : null;
}

/**
 * Pull a deep link out of a tapped push's custom data. The server stringifies
 * FCM `data` values (FCM data is string→string), so `deepLink` arrives as a
 * plain string; APNs carries it as a JSON string too. Anything else is dropped.
 */
function deepLinkFromAction(action: PushActionPerformed): string | undefined {
  const value = action.notification.data?.deepLink;
  return typeof value === "string" ? value : undefined;
}

async function onRegistration(
  deps: PushRegistrationDeps,
  platform: "ios" | "android",
  token: PushRegistrationToken,
): Promise<void> {
  const value = token.value?.trim();
  if (!value || value === registeredToken) return;
  await deps.registerToken(platform, value);
  registeredToken = value;
  logger.info(
    { src: "push-registration", platform },
    "[push-registration] registered device push token",
  );
}

/**
 * Boot device push registration. Idempotent and native-only. Resolves once the
 * `register()` call is dispatched — the token arrives asynchronously via the
 * `registration` listener. Safe to call on every shell mount; re-invoking after
 * a permission grant lets a user who granted late still register.
 */
export async function initPushRegistration(
  deps: PushRegistrationDeps = defaultDeps,
): Promise<void> {
  startPromise ??= startPushRegistration(deps)
    .then((didStart) => {
      if (!didStart) startPromise = null;
    })
    .catch((error: unknown) => {
      startPromise = null;
      throw error;
    });
  await startPromise;
}

async function startPushRegistration(
  deps: PushRegistrationDeps,
): Promise<boolean> {
  const platform = pushPlatform(deps.getPlatform());
  if (!platform) return false;

  const plugin = deps.getPlugin();
  if (
    typeof plugin.register !== "function" ||
    typeof plugin.addListener !== "function"
  ) {
    // Native build without the push plugin — nothing to register against.
    return false;
  }

  // Gate on an already-granted permission; never prompt from here.
  if (typeof plugin.checkPermissions === "function") {
    const status = await plugin.checkPermissions();
    if (status.receive !== "granted") return false;
  }

  await ensurePushListeners(deps, plugin, platform);

  await plugin.register();
  return true;
}

function ensurePushListeners(
  deps: PushRegistrationDeps,
  plugin: PushNotificationsPluginLike,
  platform: "ios" | "android",
): Promise<void> {
  listenerPromise ??= addPushListeners(deps, plugin, platform).catch(
    (error: unknown) => {
      listenerPromise = null;
      throw error;
    },
  );
  return listenerPromise;
}

async function addPushListeners(
  deps: PushRegistrationDeps,
  plugin: PushNotificationsPluginLike,
  platform: "ios" | "android",
): Promise<void> {
  const addListener = plugin.addListener;
  if (typeof addListener !== "function") {
    throw new Error("PushNotifications.addListener is unavailable");
  }
  await addListener("registration", (token: PushRegistrationToken) => {
    void onRegistration(deps, platform, token).catch((error: unknown) => {
      // error-policy:J1 transport boundary — a failed token POST leaves
      // registeredToken null so the next `registration` retries; surface it.
      logger.error(
        { src: "push-registration", platform, error },
        "[push-registration] failed to register device push token",
      );
    });
  });

  await addListener("registrationError", (error: PushRegistrationError) => {
    logger.error(
      { src: "push-registration", platform, error: error.error },
      "[push-registration] OS push registration failed",
    );
  });

  await addListener(
    "pushNotificationActionPerformed",
    (action: PushActionPerformed) => {
      const deepLink = deepLinkFromAction(action);
      if (deepLink) deps.navigate(deepLink);
    },
  );
}

/** Drop this device's token server-side and locally (logout / revoke). */
export async function unregisterPushToken(
  deps: PushRegistrationDeps = defaultDeps,
): Promise<void> {
  const token = registeredToken;
  if (!token) return;
  registeredToken = null;
  await deps.unregisterToken(token);
}

/** Test-only reset of the module-level registration guards. */
export function __resetPushRegistrationForTests(): void {
  startPromise = null;
  listenerPromise = null;
  registeredToken = null;
}
