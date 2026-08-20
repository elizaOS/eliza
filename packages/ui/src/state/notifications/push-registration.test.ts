/**
 * Drives the real push-registration flow through a fake Capacitor
 * PushNotifications plugin (the OS boundary): permission gate → register() →
 * `registration` event → token POST, tapped-push → deep-link, and idempotency.
 * Only the five injected seams (plugin, platform, build gate, client, navigate)
 * are faked;
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
  isRemotePushTransportEnabled,
  type PushRegistrationDeps,
  refreshPushRegistrationAuthority,
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
  remotePushEnabled = true,
): PushRegistrationDeps {
  return {
    getPlatform: () => platform,
    isRemotePushEnabled: () => remotePushEnabled,
    getPlugin: () => plugin,
    registerToken: vi.fn(async () => ({ ok: true })),
    unregisterToken: vi.fn(async () => ({ ok: true })),
    navigate: vi.fn(),
    sleep: vi.fn(async () => {}),
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

  it("does not touch the iOS plugin when the APNs build gate is disabled", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios", false);
    plugin.checkPermissions = vi.fn(plugin.checkPermissions);

    await initPushRegistration(deps);

    expect(plugin.checkPermissions).not.toHaveBeenCalled();
    expect(plugin.__registerCalls).toBe(0);
    expect(plugin.__listeners.registration).toHaveLength(0);
    expect(plugin.__listeners.registrationError).toHaveLength(0);
    expect(plugin.__listeners.pushNotificationActionPerformed).toHaveLength(0);
    expect(deps.registerToken).not.toHaveBeenCalled();
  });

  it("keeps Android registration enabled independently of the iOS APNs flag", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "android", true);

    await initPushRegistration(deps);

    expect(plugin.__registerCalls).toBe(1);
  });

  it("does not touch a stripped native push plugin", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "android", true);
    deps.isPluginAvailable = () => false;
    plugin.checkPermissions = vi.fn(plugin.checkPermissions);

    await initPushRegistration(deps);

    expect(plugin.checkPermissions).not.toHaveBeenCalled();
    expect(plugin.__registerCalls).toBe(0);
    expect(plugin.__listeners.registration).toHaveLength(0);
    expect(deps.registerToken).not.toHaveBeenCalled();
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

  it("retries a failed token POST without requiring another OS event", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");
    const registerToken = vi.fn(async () => ({ ok: true }));
    deps.registerToken = registerToken;
    registerToken
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce({ ok: true });

    await initPushRegistration(deps);
    emitRegistration(plugin, "retry-post-token");
    await flush();

    expect(registerToken).toHaveBeenCalledTimes(3);
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("revokes from the old authority before registering on a new authority", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");
    let authorityKey = "agent-a";
    const unregisterA = vi.fn(async () => ({ ok: true }));
    const registerA = vi.fn(async () => ({ ok: true }));
    const unregisterB = vi.fn(async () => ({ ok: true }));
    const registerB = vi.fn(async () => ({ ok: true }));
    deps.captureAuthority = () =>
      authorityKey === "agent-a"
        ? {
            key: authorityKey,
            registerToken: registerA,
            unregisterToken: unregisterA,
          }
        : {
            key: authorityKey,
            registerToken: registerB,
            unregisterToken: unregisterB,
          };

    await initPushRegistration(deps);
    emitRegistration(plugin, "authority-token");
    await flush();
    expect(registerA).toHaveBeenCalledWith("ios", "authority-token");

    authorityKey = "agent-b";
    await Promise.all([
      refreshPushRegistrationAuthority(deps),
      refreshPushRegistrationAuthority(deps),
    ]);
    expect(unregisterA).toHaveBeenCalledWith("authority-token");
    expect(plugin.__registerCalls).toBe(2);
    emitRegistration(plugin, "authority-token");
    await flush();
    expect(registerB).toHaveBeenCalledWith("ios", "authority-token");
    expect(unregisterB).not.toHaveBeenCalled();
  });

  it("cleans an old-authority POST that completes after the authority changes", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");
    let authorityKey = "agent-a";
    let finishRegisterA: (() => void) | undefined;
    const registerA = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          finishRegisterA = () => resolve({ ok: true });
        }),
    );
    const unregisterA = vi.fn(async () => ({ ok: true }));
    const registerB = vi.fn(async () => ({ ok: true }));
    const unregisterB = vi.fn(async () => ({ ok: true }));
    deps.captureAuthority = () =>
      authorityKey === "agent-a"
        ? {
            key: authorityKey,
            registerToken: registerA,
            unregisterToken: unregisterA,
          }
        : {
            key: authorityKey,
            registerToken: registerB,
            unregisterToken: unregisterB,
          };

    await initPushRegistration(deps);
    emitRegistration(plugin, "racing-token");
    await flush();
    expect(registerA).toHaveBeenCalledOnce();

    authorityKey = "agent-b";
    await refreshPushRegistrationAuthority(deps);
    finishRegisterA?.();
    await flush();

    expect(unregisterA).toHaveBeenCalledWith("racing-token");
    emitRegistration(plugin, "racing-token");
    await flush();
    expect(registerB).toHaveBeenCalledWith("ios", "racing-token");
  });

  it("revokes a rotated OS token after the replacement is registered", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");

    await initPushRegistration(deps);
    emitRegistration(plugin, "old-token");
    await flush();
    emitRegistration(plugin, "new-token");
    await flush();

    expect(deps.registerToken).toHaveBeenNthCalledWith(2, "ios", "new-token");
    expect(deps.unregisterToken).toHaveBeenCalledWith("old-token");
  });

  it("serializes overlapping token callbacks so an older completion cannot win", async () => {
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");
    let finishOld: (() => void) | undefined;
    deps.registerToken = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ ok: true }>((resolve) => {
            finishOld = () => resolve({ ok: true });
          }),
      )
      .mockResolvedValue({ ok: true });

    await initPushRegistration(deps);
    emitRegistration(plugin, "old-token");
    emitRegistration(plugin, "new-token");
    await flush();
    expect(deps.registerToken).toHaveBeenCalledTimes(1);

    finishOld?.();
    await flush();
    expect(deps.registerToken).toHaveBeenNthCalledWith(2, "ios", "new-token");
    expect(deps.unregisterToken).toHaveBeenCalledWith("old-token");
  });

  it("does not mistake a failed old-token cleanup for a failed replacement POST", async () => {
    const loggedError = vi.spyOn(console, "error").mockImplementation(() => {});
    const plugin = makePlugin("granted");
    const deps = makeDeps(plugin, "ios");
    deps.unregisterToken = vi.fn(async () => {
      throw new Error("cleanup unavailable");
    });

    await initPushRegistration(deps);
    emitRegistration(plugin, "old-token");
    await flush();
    emitRegistration(plugin, "new-token");
    await flush();
    emitRegistration(plugin, "new-token");
    await flush();

    expect(deps.registerToken).toHaveBeenCalledTimes(2);
    expect(deps.unregisterToken).toHaveBeenCalledTimes(6);
    expect(loggedError).toHaveBeenCalled();
  });
});

describe("isRemotePushTransportEnabled", () => {
  it("fails closed for iOS unless the build flag is exactly 1", () => {
    expect(isRemotePushTransportEnabled("ios", undefined)).toBe(false);
    expect(isRemotePushTransportEnabled("ios", "0")).toBe(false);
    expect(isRemotePushTransportEnabled("ios", "true")).toBe(false);
    expect(isRemotePushTransportEnabled("ios", " 1 ")).toBe(false);
    expect(isRemotePushTransportEnabled("ios", "1")).toBe(true);
  });

  it("keeps Android FCM enabled independently of the APNs flag", () => {
    expect(isRemotePushTransportEnabled("android", undefined)).toBe(true);
    expect(isRemotePushTransportEnabled("android", "0")).toBe(true);
  });
});
