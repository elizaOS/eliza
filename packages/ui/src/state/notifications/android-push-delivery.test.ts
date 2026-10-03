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
  initPushRegistration,
  refreshPushRegistrationAuthority,
  unregisterPushToken,
} from "./push-registration";

function registration(deliveryEnabled = true) {
  let authority = "owner-at-backend-one";
  const events = new Map<string, (event: { value: string }) => void>();
  const registerToken = vi.fn(async () => ({ ok: true, deliveryEnabled }));
  const deps: PushRegistrationDeps = {
    getPlatform: () => "android",
    isRemotePushEnabled: () => true,
    getPlugin: () => ({
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
function ingest(id: string) {
  __ingestNotificationForTests({
    id,
    title: "Same title",
    category: "reminder",
    priority: "normal",
    createdAt: Date.now(),
  } as AgentNotification);
}
afterEach(() => {
  __resetNotificationStoreForTests();
  __resetPushRegistrationForTests();
  delivery.show.mockClear();
  delivery.platform = "android";
});

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
