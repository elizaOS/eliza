/**
 * Drives the real push-registration flow through a fake Capacitor
 * PushNotifications plugin (the OS boundary): permission gate → register() →
 * `registration` event → token POST, tapped-push → deep-link, and idempotency.
 * Only the four injected seams (plugin, platform, client, navigate) are faked;
 * the registration logic under test is the production module.
 */
import type { PluginListenerHandle } from "@capacitor/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PushActionPerformed,
  PushNotificationsPluginLike,
  PushRegistrationError,
  PushRegistrationToken,
} from "../../bridge/native-plugins";
import type { FrontendPlatform } from "../../platform/platform-guards";
import {
  __resetPushRegistrationForTests,
  initPushRegistration,
  type PushRegistrationDeps,
  unregisterPushToken,
} from "./push-registration";

type ListenerMap = {
  registration?: (token: PushRegistrationToken) => void;
  registrationError?: (error: PushRegistrationError) => void;
  pushNotificationActionPerformed?: (action: PushActionPerformed) => void;
};

interface FakePlugin extends PushNotificationsPluginLike {
  __listeners: ListenerMap;
  __registerCalls: number;
}

function makePlugin(
  permission: "granted" | "denied" | "prompt" = "granted",
): FakePlugin {
  const listeners: ListenerMap = {};
  const handle: PluginListenerHandle = { remove: async () => {} };
  return {
    __listeners: listeners,
    __registerCalls: 0,
    checkPermissions: async () => ({ receive: permission }),
    register: async function (this: FakePlugin) {
      this.__registerCalls++;
    },
    unregister: async () => {},
    addListener: (async (event: keyof ListenerMap, fn: never) => {
      listeners[event] = fn as never;
      return handle;
    }) as PushNotificationsPluginLike["addListener"],
    removeAllListeners: async () => {},
  };
}

function makeDeps(
  plugin: FakePlugin,
  platform: FrontendPlatform,
): PushRegistrationDeps {
  return {
    getPlatform: () => platform,
    getPlugin: () => plugin,
    registerToken: vi.fn(async () => ({ ok: true })),
    unregisterToken: vi.fn(async () => ({ ok: true })),
    navigate: vi.fn(),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("initPushRegistration", () => {
  beforeEach(() => __resetPushRegistrationForTests());
  afterEach(() => __resetPushRegistrationForTests());

  it("registers the OS token to the server on the registration event (iOS/APNs)", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    expect(plugin.__registerCalls).toBe(1);

    // OS mints the token and fires `registration` asynchronously.
    plugin.__listeners.registration?.({ value: "apns-device-token" });
    await flush();

    expect(deps.registerToken).toHaveBeenCalledWith("ios", "apns-device-token");
  });

  it("registers android tokens under the FCM platform", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "android");

    await initPushRegistration(deps);
    plugin.__listeners.registration?.({ value: "fcm-token" });
    await flush();

    expect(deps.registerToken).toHaveBeenCalledWith("android", "fcm-token");
  });

  it("does not re-POST an unchanged token when registration re-fires", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    plugin.__listeners.registration?.({ value: "same-token" });
    await flush();
    plugin.__listeners.registration?.({ value: "same-token" });
    await flush();

    expect(deps.registerToken).toHaveBeenCalledTimes(1);
  });

  it("does not register when permission is not granted", async () => {
    const plugin = makePlugin("denied");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);

    expect(plugin.__registerCalls).toBe(0);
    expect(deps.registerToken).not.toHaveBeenCalled();
  });

  it("no-ops on non-native platforms (web/desktop)", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "web");

    await initPushRegistration(deps);

    expect(plugin.__registerCalls).toBe(0);
    expect(deps.registerToken).not.toHaveBeenCalled();
  });

  it("is idempotent — a second boot does not double-register listeners", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    await initPushRegistration(deps);

    expect(plugin.__registerCalls).toBe(1);
  });

  it("deep-links through the injected navigator when a push is tapped", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    plugin.__listeners.pushNotificationActionPerformed?.({
      actionId: "tap",
      notification: { data: { deepLink: "/tasks", notificationId: "abc" } },
    });

    expect(deps.navigate).toHaveBeenCalledWith("/tasks");
  });

  it("ignores a tapped push with no deep link", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    plugin.__listeners.pushNotificationActionPerformed?.({
      actionId: "tap",
      notification: { data: { notificationId: "abc" } },
    });

    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it("unregisterPushToken drops the last registered token server-side", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    plugin.__listeners.registration?.({ value: "tok-to-drop" });
    await flush();

    await unregisterPushToken(deps);
    expect(deps.unregisterToken).toHaveBeenCalledWith("tok-to-drop");
  });
});
