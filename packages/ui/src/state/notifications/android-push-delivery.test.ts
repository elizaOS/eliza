// @vitest-environment jsdom

import type { AgentNotification } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import type { PushRegistrationDeps } from "./push-registration";

const delivery = vi.hoisted(() => ({
  show: vi.fn(async () => "local"),
  platform: "android",
}));
vi.mock("../../bridge/notification-delivery", () => ({
  deliverSystemNotification: delivery.show,
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => delivery.platform,
    isNativePlatform: () => delivery.platform !== "web",
  },
}));

import {
  __getStateForTests,
  __ingestEphemeralNotificationForTests,
  __ingestNotificationForTests,
  __resetNotificationStoreForTests,
} from "./notification-store";
import {
  __resetPushRegistrationForTests,
  captureNativeNotificationOwner,
  hasAndroidPushDelivery,
  initPushRegistration,
  refreshPushRegistrationAuthority,
  unregisterPushToken,
} from "./push-registration";

it("uses non-GMS native delivery without inventing or registering an FCM token", async () => {
  let owner = "native-owner-one";
  const status = vi.fn(async () => ({
    transport: "native" as const,
    owner: "a".repeat(64),
    activated: true,
    enabled: true,
    connected: true,
    state: "connected",
    batteryExempt: true,
    backgroundReliable: true,
    notificationsAllowed: true,
    inbox: null,
  }));
  const register = vi.fn(async () => {});
  const unregister = vi.fn(async () => {});
  const registerToken = vi.fn(async () => ({ ok: true }));
  const deps: PushRegistrationDeps = {
    getPlatform: () => "android",
    isRemotePushEnabled: () => true,
    getPlugin: () => ({
      getNativeNotificationDeliveryStatus: status,
      checkPermissions: async () => ({ receive: "granted" }),
      register,
      unregister,
      addListener: async () => ({ remove: async () => {} }),
    }),
    registerToken,
    unregisterToken: vi.fn(async () => ({ ok: true })),
    navigate: vi.fn(),
    captureAuthority: () => ({
      key: owner,
      registerToken,
      unregisterToken: vi.fn(async () => ({ ok: true })),
    }),
  };
  await initPushRegistration(deps);
  expect(register).toHaveBeenCalledOnce();
  expect(registerToken).not.toHaveBeenCalled();
  expect(await hasAndroidPushDelivery("message")).toBe(true);
  const capturedOwner = captureNativeNotificationOwner();
  expect(capturedOwner).toBe("a".repeat(64));
  status.mockResolvedValueOnce({
    transport: "native",
    owner: "b".repeat(64),
    activated: true,
    enabled: true,
    connected: true,
    state: "connected",
    batteryExempt: true,
    backgroundReliable: true,
    notificationsAllowed: true,
    inbox: null,
  });
  // A native account/cookie switch at the same URL cannot upgrade an earlier
  // record's captured ownership to the freshly looked-up owner.
  expect(await hasAndroidPushDelivery("message")).toBe(false);
  expect(capturedOwner).toBe("a".repeat(64));
  status.mockResolvedValueOnce({
    transport: "native",
    owner: "a".repeat(64),
    activated: true,
    enabled: false,
    connected: false,
    state: "authorization_rejected",
    batteryExempt: true,
    backgroundReliable: false,
    notificationsAllowed: true,
    inbox: null,
  });
  expect(await hasAndroidPushDelivery("message")).toBe(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  status.mockResolvedValueOnce({
    transport: "native",
    owner: "a".repeat(64),
    activated: true,
    enabled: true,
    connected: true,
    state: "connected",
    batteryExempt: false,
    backgroundReliable: false,
    notificationsAllowed: true,
    inbox: null,
  });
  expect(await hasAndroidPushDelivery("message")).toBe(false);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  ingest("native-notification");
  await vi.waitFor(() =>
    expect(__getStateForTests().notifications).toHaveLength(1),
  );
  expect(delivery.show).not.toHaveBeenCalled();
  owner = "native-owner-two";
  expect(captureNativeNotificationOwner()).toBeNull();
  expect(await hasAndroidPushDelivery("message")).toBe(false);
  await unregisterPushToken(deps);
  expect(unregister).toHaveBeenCalledOnce();
  expect(registerToken).not.toHaveBeenCalled();
});

function registration(deliveryEnabled = true) {
  let authority = "owner-at-backend-one";
  const events = new Map<string, (event: { value: string }) => void>();
  const registerToken = vi.fn(async () => ({ ok: true, deliveryEnabled }));
  const deps: PushRegistrationDeps = {
    getPlatform: () => "android",
    isRemotePushEnabled: () => true,
    getPlugin: () => ({
      getReminderDataCapabilities: async () => ({
        reminderDataNotifications: true,
      }),
      checkPermissions: async () => ({ receive: "granted" }),
      register: async () => {
        events.get("registration")?.({ value: "native-device-token" });
      },
      addListener: async (name, listener) => {
        events.set(name, listener as (event: { value: string }) => void);
        return { remove: async () => {} };
      },
    }),
    registerToken,
    unregisterToken: async () => ({ ok: true }),
    navigate: () => {},
    captureAuthority: () => ({
      key: authority,
      registerToken,
      unregisterToken: async () => ({ ok: true }),
    }),
    sleep: async () => {},
  };
  return {
    deps,
    registerToken,
    switchAuthority: () => {
      authority = "owner-at-backend-two";
    },
  };
}
function ingest(
  id: string,
  category: AgentNotification["category"] = "reminder",
) {
  __ingestNotificationForTests({
    id,
    title: "Same title",
    category,
    priority: "normal",
    createdAt: Date.now(),
  } as AgentNotification);
}
afterEach(() => {
  __resetNotificationStoreForTests();
  __resetPushRegistrationForTests();
  delivery.show.mockClear();
  delivery.platform = "android";
  vi.restoreAllMocks();
});

it.each([false, undefined])(
  "keeps foreground reminder presentation without native capability %j",
  async (capability) => {
    const r = registration();
    const plugin = r.deps.getPlugin();
    r.deps.getPlugin = () => ({
      ...plugin,
      getReminderDataCapabilities:
        capability === undefined
          ? undefined
          : async () => ({ reminderDataNotifications: capability }),
    });
    await initPushRegistration(r.deps);
    await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
    ingest("81dcd247-fae7-4cf8-95f0-63c85f410851");
    await vi.waitFor(() => expect(delivery.show).toHaveBeenCalledOnce());
    expect(__getStateForTests().notifications).toHaveLength(1);
  },
);

it("keeps foreground non-reminder presentation with native reminder capability", async () => {
  const r = registration();
  await initPushRegistration(r.deps);
  await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
  ingest("9499a986-550d-4ecb-9fa3-7d2de1f7ba28", "system");
  await vi.waitFor(() => expect(delivery.show).toHaveBeenCalledOnce());
  expect(__getStateForTests().notifications).toHaveLength(1);
});

it.each(["reminder", "system"] as const)(
  "keeps background %s presentation with configured FCM",
  async (category) => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const r = registration();
    const plugin = r.deps.getPlugin();
    r.deps.getPlugin = () => ({
      ...plugin,
      getReminderDataCapabilities: undefined,
    });
    await initPushRegistration(r.deps);
    await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
    ingest("d20d7c43-ef30-47f4-b35e-47ac993b2b80", category);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivery.show).not.toHaveBeenCalled();
    expect(__getStateForTests().notifications).toHaveLength(1);
  },
);

it("keeps the canonical Android inbox arrival without a second local OS projection after FCM ownership is confirmed", async () => {
  const r = registration();
  await initPushRegistration(r.deps);
  await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));
  ingest("canonical-notification");
  expect(__getStateForTests().notifications.map((n) => n.id)).toContain(
    "canonical-notification",
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivery.show).not.toHaveBeenCalled();
});
it("retains local fallback when the backend stores a token but has no configured push sender", async () => {
  const r = registration(false);
  await initPushRegistration(r.deps);
  await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
  ingest("local-fallback");
  await vi.waitFor(() => expect(delivery.show).toHaveBeenCalledOnce());
});
it("invalidates FCM ownership immediately on authority change and logout", async () => {
  const r = registration();
  await initPushRegistration(r.deps);
  await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
  await new Promise((resolve) => setTimeout(resolve, 0));
  r.switchAuthority();
  ingest("new-authority");
  await vi.waitFor(() => expect(delivery.show).toHaveBeenCalledOnce());
  await refreshPushRegistrationAuthority(r.deps);
  await unregisterPushToken(r.deps);
  ingest("logged-out");
  await vi.waitFor(() => expect(delivery.show).toHaveBeenCalledTimes(2));
});

it("waits for current token POST while the backend already has a persisted FCM token", async () => {
  const r = registration();
  let resolvePost!: (result: { ok: boolean; deliveryEnabled: boolean }) => void;
  r.registerToken.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
  );
  await initPushRegistration(r.deps);
  await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
  ingest("startup-notification");
  expect(__getStateForTests().notifications).toHaveLength(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivery.show).not.toHaveBeenCalled();
  resolvePost({ ok: true, deliveryEnabled: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivery.show).not.toHaveBeenCalled();
});
it("delivers the pending arrival locally when registration confirms no sender", async () => {
  const r = registration();
  let resolvePost!: (result: { ok: boolean; deliveryEnabled: boolean }) => void;
  r.registerToken.mockImplementation(
    () =>
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
  );
  await initPushRegistration(r.deps);
  await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
  ingest("pending-fallback");
  expect(delivery.show).not.toHaveBeenCalled();
  resolvePost({ ok: true, deliveryEnabled: false });
  await vi.waitFor(() => expect(delivery.show).toHaveBeenCalledOnce());
});
it("aborts old-authority projection while a pending token POST settles", async () => {
  const r = registration();
  let resolvePost!: (result: { ok: boolean; deliveryEnabled: boolean }) => void;
  r.registerToken.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolvePost = resolve;
      }),
  );
  await initPushRegistration(r.deps);
  await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
  ingest("old-authority-arrival");
  r.switchAuthority();
  __resetNotificationStoreForTests();
  const rotation = refreshPushRegistrationAuthority(r.deps);
  resolvePost({ ok: true, deliveryEnabled: true });
  await rotation;
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(delivery.show).not.toHaveBeenCalled();
  expect(__getStateForTests().notifications).toHaveLength(0);
});
it("preserves in-app-only notification behavior when FCM owns server arrivals", async () => {
  const r = registration();
  await initPushRegistration(r.deps);
  await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
  __ingestEphemeralNotificationForTests({
    id: "local-only",
    title: "Local action",
    category: "system",
    priority: "normal",
    createdAt: Date.now(),
  } as AgentNotification);
  expect(delivery.show).not.toHaveBeenCalled();
  expect(__getStateForTests().notifications.map((n) => n.id)).toContain(
    "local-only",
  );
});
it("retains local fallback after a failed token POST", async () => {
  const r = registration();
  r.registerToken.mockRejectedValue(new Error("backend offline"));
  await initPushRegistration(r.deps);
  ingest("network-fallback");
  await vi.waitFor(() => expect(delivery.show).toHaveBeenCalledOnce());
  expect(r.registerToken).toHaveBeenCalledTimes(3);
});

it.each(["ios", "web"])(
  "keeps %s renderer notification delivery unchanged",
  async (platform) => {
    const r = registration();
    await initPushRegistration(r.deps);
    await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
    delivery.platform = platform;
    ingest("other-platform-arrival");
    await vi.waitFor(() => expect(delivery.show).toHaveBeenCalledOnce());
  },
);

it.each([true, false, "true", undefined])(
  "advertises native data projection only for strict capability %j",
  async (capability) => {
    const r = registration();
    const originalPlugin = r.deps.getPlugin();
    r.deps.getPlugin = () => ({
      ...originalPlugin,
      getReminderDataCapabilities: async () => ({
        reminderDataNotifications: capability as boolean,
      }),
    });
    await initPushRegistration(r.deps);
    await vi.waitFor(() => expect(r.registerToken).toHaveBeenCalledOnce());
    if (capability === true)
      expect(r.registerToken).toHaveBeenCalledWith(
        "android",
        "native-device-token",
        true,
      );
    else
      expect(r.registerToken).toHaveBeenCalledWith(
        "android",
        "native-device-token",
      );
  },
);
it("keeps older native plugin registration on legacy payloads", async () => {
  const r = registration();
  const originalPlugin = r.deps.getPlugin();
  r.deps.getPlugin = () => ({
    ...originalPlugin,
    getReminderDataCapabilities: async () => {
      throw new Error("method not implemented");
    },
  });
  await initPushRegistration(r.deps);
  await vi.waitFor(() =>
    expect(r.registerToken).toHaveBeenCalledWith(
      "android",
      "native-device-token",
    ),
  );
  ingest("566e13eb-0359-4548-b489-5a5a969bc7b1");
  await vi.waitFor(() => expect(delivery.show).toHaveBeenCalledOnce());
});
