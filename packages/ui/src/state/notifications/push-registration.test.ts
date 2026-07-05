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
  registration: Array<(token: PushRegistrationToken) => void>;
  registrationError: Array<(error: PushRegistrationError) => void>;
  pushNotificationActionPerformed: Array<(action: PushActionPerformed) => void>;
};

interface FakePlugin extends PushNotificationsPluginLike {
  __listeners: ListenerMap;
  __registerCalls: number;
}

function makePlugin(
  permission: "granted" | "denied" | "prompt" = "granted",
): FakePlugin {
  const listeners: ListenerMap = {
    registration: [],
    registrationError: [],
    pushNotificationActionPerformed: [],
  };
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
      listeners[event].push(fn as never);
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

function emitRegistration(plugin: FakePlugin, token: string): void {
  for (const listener of plugin.__listeners.registration) {
    listener({ value: token });
  }
}

function emitPushTap(plugin: FakePlugin, data: Record<string, unknown>): void {
  for (const listener of plugin.__listeners.pushNotificationActionPerformed) {
    listener({
      actionId: "tap",
      notification: { data },
    });
  }
}

describe("initPushRegistration", () => {
  beforeEach(() => __resetPushRegistrationForTests());
  afterEach(() => __resetPushRegistrationForTests());

  it("registers the OS token to the server on the registration event (iOS/APNs)", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    expect(plugin.__registerCalls).toBe(1);

    // OS mints the token and fires `registration` asynchronously.
    emitRegistration(plugin, "apns-device-token");
    await flush();

    expect(deps.registerToken).toHaveBeenCalledWith("ios", "apns-device-token");
  });

  it("registers android tokens under the FCM platform", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "android");

    await initPushRegistration(deps);
    emitRegistration(plugin, "fcm-token");
    await flush();

    expect(deps.registerToken).toHaveBeenCalledWith("android", "fcm-token");
  });

  it("does not re-POST an unchanged token when registration re-fires", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    emitRegistration(plugin, "same-token");
    await flush();
    emitRegistration(plugin, "same-token");
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

  it("retries after permission is granted later", async () => {
    let permission: "granted" | "denied" = "denied";
    const plugin = makePlugin(permission);
    plugin.checkPermissions = async () => ({ receive: permission });
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    permission = "granted";
    await initPushRegistration(deps);

    expect(plugin.__registerCalls).toBe(1);
  });

  it("retries when native register() fails before the OS accepts the request", async () => {
    const plugin = makePlugin("granted");
    plugin.register = async function (this: FakePlugin) {
      this.__registerCalls++;
      if (this.__registerCalls === 1) {
        throw new Error("native bridge unavailable");
      }
    };
    const deps = makeDeps(plugin, "ios");

    await expect(initPushRegistration(deps)).rejects.toThrow(
      "native bridge unavailable",
    );
    await initPushRegistration(deps);

    expect(plugin.__registerCalls).toBe(2);
    expect(plugin.__listeners.registration).toHaveLength(1);
    expect(plugin.__listeners.registrationError).toHaveLength(1);
    expect(plugin.__listeners.pushNotificationActionPerformed).toHaveLength(1);

    emitRegistration(plugin, "retry-token");
    await flush();
    expect(deps.registerToken).toHaveBeenCalledTimes(1);

    emitPushTap(plugin, { deepLink: "/tasks", notificationId: "abc" });
    expect(deps.navigate).toHaveBeenCalledTimes(1);
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
    emitPushTap(plugin, { deepLink: "/tasks", notificationId: "abc" });

    expect(deps.navigate).toHaveBeenCalledWith("/tasks");
  });

  it("ignores a tapped push with no deep link", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    emitPushTap(plugin, { notificationId: "abc" });

    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it("unregisterPushToken drops the last registered token server-side", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    emitRegistration(plugin, "tok-to-drop");
    await flush();

    await unregisterPushToken(deps);
    expect(deps.unregisterToken).toHaveBeenCalledWith("tok-to-drop");
  });
});
