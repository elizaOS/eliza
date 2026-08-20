/**
 * Device remote-push registration: acquires the OS push token (APNs on iOS, FCM
 * on Android) from `@capacitor/push-notifications` and hands it to the server so
 * a backgrounded/killed device can be reached (`POST /api/notifications/push-tokens`).
 * This is the client trigger the server's push-token routes had been missing —
 * without it `PushTokenRegistry.list()` is always empty and the whole APNs/FCM
 * stack is a dead pipeline.
 *
 * Flow (native only — a no-op on web/desktop where the plugin is absent):
 *   1. On iOS, require the same build-time APNs flag that patches the native
 *      Info.plist. Direct/simulator builds default off because they do not carry
 *      the `aps-environment` entitlement. Android remains enabled.
 *   2. Gate on a *granted* notification permission. Registration never prompts;
 *      the ask is primed elsewhere (the onboarding permission modal). We only
 *      register once the user has already said yes, so an unregistered token is
 *      the honest signal "permission not granted", not a swallowed failure.
 *   3. Attach the `registration` listener, then call `register()`. The OS mints
 *      the token asynchronously and fires the listener; we POST it. iOS routes
 *      the APNs token through the AppDelegate → Capacitor bridge; Android reads
 *      the FCM token directly.
 *   4. Attach `pushNotificationActionPerformed` so a tapped push deep-links via
 *      the same scheme-checked `navigateDeepLink` the in-app center uses.
 *
 * The listeners live for the app's lifetime; `initPushRegistration` is
 * idempotent so remounting the shell (or re-calling after a permission grant)
 * does not double-register.
 */

import { Capacitor } from "@capacitor/core";
import { logger } from "@elizaos/logger";
import { client, ElizaClient } from "../../api/client";
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
import { loadAgentProfileRegistry } from "../agent-profiles";
import { navigateDeepLink } from "./navigate-deep-link";

/**
 * Injectable boundaries. The Capacitor push plugin, the platform detector, the
 * build gate, HTTP client, and deep-link navigator are the five seams to the outside
 * world; injecting them lets the registration flow be driven end-to-end in a
 * test without a real device, while production wires the real singletons.
 */
export interface PushRegistrationDeps {
  getPlatform: () => FrontendPlatform;
  isRemotePushEnabled: (platform: "ios" | "android") => boolean;
  isPluginAvailable?: (name: string) => boolean;
  getPlugin: () => PushNotificationsPluginLike;
  registerToken: (
    platform: "ios" | "android",
    token: string,
  ) => Promise<unknown>;
  unregisterToken: (token: string) => Promise<unknown>;
  navigate: (deepLink: string) => void;
  captureAuthority?: () => PushRegistrationAuthority;
  sleep?: (delayMs: number) => Promise<void>;
}

export interface PushRegistrationAuthority {
  key: string;
  registerToken: PushRegistrationDeps["registerToken"];
  unregisterToken: PushRegistrationDeps["unregisterToken"];
}

function captureClientAuthority(): PushRegistrationAuthority {
  const baseUrl = client.getBaseUrl();
  const token = client.getRestAuthToken();
  const profileId = loadAgentProfileRegistry().activeProfileId ?? "unscoped";
  const authorityClient = new ElizaClient(baseUrl, token ?? undefined);
  return {
    key: `${profileId}\u0000${baseUrl}\u0000${token ?? ""}`,
    registerToken: (platform, value) =>
      authorityClient.registerPushToken(platform, value),
    unregisterToken: (value) => authorityClient.unregisterPushToken(value),
  };
}

const defaultDeps: PushRegistrationDeps = {
  getPlatform: getFrontendPlatform,
  isRemotePushEnabled: isRemotePushTransportEnabled,
  isPluginAvailable: (name) => Capacitor.isPluginAvailable(name),
  getPlugin: getPushNotificationsPlugin,
  registerToken: (platform, token) => client.registerPushToken(platform, token),
  unregisterToken: (token) => client.unregisterPushToken(token),
  navigate: navigateDeepLink,
  captureAuthority: captureClientAuthority,
  sleep: (delayMs) =>
    new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }),
};

let startPromise: Promise<void> | null = null;
let listenerPromise: Promise<void> | null = null;
/** The most recent token we POSTed, so a re-fired `registration` is a no-op. */
let activeAuthorityKey: string | null = null;
let authorityEpoch = 0;
let authorityTransition: Promise<void> = Promise.resolve();
let registrationTransition: Promise<void> = Promise.resolve();
interface RegisteredPushToken {
  value: string;
  authorityKey: string;
  unregister: PushRegistrationDeps["unregisterToken"];
  sleep?: PushRegistrationDeps["sleep"];
}
let registeredToken: RegisteredPushToken | null = null;
let pendingRevocations: RegisteredPushToken[] = [];

const TOKEN_POST_RETRY_DELAYS_MS = [0, 250, 1_000] as const;

async function unregisterWithRetry(
  unregister: PushRegistrationDeps["unregisterToken"],
  value: string,
  sleep: PushRegistrationDeps["sleep"],
): Promise<void> {
  let lastError: unknown;
  for (const delayMs of TOKEN_POST_RETRY_DELAYS_MS) {
    if (delayMs > 0) await sleep?.(delayMs);
    try {
      await unregister(value);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function queueRevocation(token: RegisteredPushToken): void {
  if (
    pendingRevocations.some(
      (candidate) =>
        candidate.value === token.value &&
        candidate.authorityKey === token.authorityKey,
    )
  ) {
    return;
  }
  pendingRevocations.push(token);
}

async function drainPendingRevocations(): Promise<void> {
  const failed: RegisteredPushToken[] = [];
  let firstError: unknown;
  for (const token of pendingRevocations) {
    try {
      await unregisterWithRetry(
        token.unregister,
        token.value,
        token.sleep ?? defaultDeps.sleep,
      );
    } catch (error) {
      firstError ??= error;
      failed.push(token);
    }
  }
  pendingRevocations = failed;
  if (firstError !== undefined) throw firstError;
}

/** Only the native mobile platforms carry a remote-push transport. */
function pushPlatform(platform: FrontendPlatform): "ios" | "android" | null {
  return platform === "ios" || platform === "android" ? platform : null;
}

/**
 * Resolve the build-time remote-push transport gate. iOS is fail-closed unless
 * the native plist patcher receives the same explicit `1`; Android continues
 * to use FCM without depending on the APNs-only flag.
 */
export function isRemotePushTransportEnabled(
  platform: "ios" | "android",
  iosApnsFlag = import.meta.env?.VITE_ELIZA_APNS_ENABLED,
): boolean {
  return platform === "android" || iosApnsFlag === "1";
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
  if (!value) return;
  const authority = deps.captureAuthority?.() ?? {
    key: "default",
    registerToken: deps.registerToken,
    unregisterToken: deps.unregisterToken,
  };
  const epoch = authorityEpoch;
  await drainPendingRevocations();
  if (
    registeredToken?.value === value &&
    registeredToken.authorityKey === authority.key
  ) {
    return;
  }
  let lastError: unknown;
  for (const delayMs of TOKEN_POST_RETRY_DELAYS_MS) {
    if (epoch !== authorityEpoch || authority.key !== activeAuthorityKey)
      return;
    if (delayMs > 0) {
      await (deps.sleep ?? defaultDeps.sleep)?.(delayMs);
    }
    try {
      await authority.registerToken(platform, value);
    } catch (error) {
      lastError = error;
      continue;
    }
    if (epoch !== authorityEpoch || authority.key !== activeAuthorityKey) {
      queueRevocation({
        value,
        authorityKey: authority.key,
        unregister: authority.unregisterToken,
        sleep: deps.sleep,
      });
      await drainPendingRevocations();
      return;
    }
    const previous = registeredToken;
    registeredToken = {
      value,
      authorityKey: authority.key,
      unregister: authority.unregisterToken,
      sleep: deps.sleep,
    };
    if (
      previous &&
      (previous.value !== value || previous.authorityKey !== authority.key)
    ) {
      queueRevocation(previous);
      await drainPendingRevocations();
    }
    lastError = undefined;
    break;
  }
  if (lastError !== undefined) throw lastError;
  logger.info(
    { src: "push-registration", platform },
    "[push-registration] registered device push token",
  );
}

function enqueueRegistration(
  deps: PushRegistrationDeps,
  platform: "ios" | "android",
  token: PushRegistrationToken,
): void {
  registrationTransition = registrationTransition
    .then(() => onRegistration(deps, platform, token))
    .catch((error: unknown) => {
      // error-policy:J1 the native registration event is a transport boundary;
      // retaining pending revocations lets a later event retry cleanup.
      logger.error(
        { src: "push-registration", platform, error },
        "[push-registration] failed to register device push token",
      );
    });
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
  if (!deps.isRemotePushEnabled(platform)) return false;
  if (deps.isPluginAvailable?.("PushNotifications") === false) return false;

  activeAuthorityKey = (deps.captureAuthority?.() ?? { key: "default" }).key;

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
    enqueueRegistration(deps, platform, token);
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
  _deps: PushRegistrationDeps = defaultDeps,
): Promise<void> {
  const token = registeredToken;
  if (token) {
    queueRevocation(token);
    if (registeredToken === token) registeredToken = null;
  }
  await drainPendingRevocations();
}

/** Revoke the prior authority's token, then acquire it for the current target. */
export function refreshPushRegistrationAuthority(
  deps: PushRegistrationDeps = defaultDeps,
  force = false,
): Promise<void> {
  const requestedAuthorityKey = (
    deps.captureAuthority?.() ?? { key: "default" }
  ).key;
  if (!force && requestedAuthorityKey === activeAuthorityKey) {
    return authorityTransition;
  }
  authorityEpoch += 1;
  const performTransition = async () => {
    const nextAuthorityKey = (deps.captureAuthority?.() ?? { key: "default" })
      .key;
    if (!force && nextAuthorityKey === activeAuthorityKey) return;
    await unregisterPushToken(deps);
    startPromise = null;
    activeAuthorityKey = null;
    await initPushRegistration(deps);
  };
  const transition = authorityTransition.then(
    performTransition,
    async (error) => {
      // error-policy:J5 the failed transition remains observed by the caller;
      // log it before recovering the serialization queue for the next event.
      logger.warn(
        { src: "push-registration", error },
        "[push-registration] recovering failed authority transition",
      );
      await performTransition();
    },
  );
  authorityTransition = transition;
  return transition;
}

/** Test-only reset of the module-level registration guards. */
export function __resetPushRegistrationForTests(): void {
  startPromise = null;
  listenerPromise = null;
  activeAuthorityKey = null;
  authorityEpoch = 0;
  authorityTransition = Promise.resolve();
  registrationTransition = Promise.resolve();
  registeredToken = null;
  pendingRevocations = [];
}
