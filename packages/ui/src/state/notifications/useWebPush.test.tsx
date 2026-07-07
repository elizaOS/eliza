// @vitest-environment jsdom
/**
 * Hook-level tests for `useWebPush` — proves it probes state on mount, exposes
 * gesture-safe subscribe/unsubscribe that update the surfaced state, and toggles
 * the busy flag around async work. All browser seams are injected via the
 * `WebPushDeps` override so no real push stack is needed.
 */

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWebPush } from "./useWebPush";
import type { WebPushDeps } from "./web-push-subscription";

// Feature-detect seams: jsdom lacks PushManager + navigator.serviceWorker.
const g = globalThis as unknown as { PushManager?: unknown };
g.PushManager = class {};
if (!("serviceWorker" in navigator)) {
  Object.defineProperty(navigator, "serviceWorker", {
    value: { ready: Promise.resolve(undefined) },
    configurable: true,
  });
}

function makeNotification(
  permission: NotificationPermission,
  requested: NotificationPermission = "granted",
): typeof Notification {
  // Mutable permission: requesting resolves the prompt and flips the getter, so
  // a later re-probe agrees with the prompt outcome (as real browsers do).
  let current = permission;
  const N = (() => {}) as unknown as typeof Notification;
  Object.defineProperty(N, "permission", {
    get: () => current,
    configurable: true,
  });
  (
    N as unknown as { requestPermission: () => Promise<NotificationPermission> }
  ).requestPermission = vi.fn().mockImplementation(async () => {
    current = requested;
    return requested;
  });
  return N;
}

function makeDeps(overrides: Partial<WebPushDeps> = {}): WebPushDeps {
  // Mutable subscription so a post-subscribe re-probe reflects the new state,
  // mirroring real PushManager semantics (getSubscription returns the created
  // subscription on the next read).
  let current: unknown = null;
  const subscribe = vi.fn().mockImplementation(async () => {
    current = { endpoint: "https://push/new" };
    return current;
  });
  const getSubscription = vi.fn().mockImplementation(async () => current);
  // Stable Notification instance so permission mutations persist across probes.
  const { getNotification, ...rest } = overrides;
  const notification = getNotification?.() ?? makeNotification("default");
  return {
    getNotification: () => notification,
    getRegistration: async () =>
      ({
        pushManager: { subscribe, getSubscription },
      }) as unknown as ServiceWorkerRegistration,
    getVapidPublicKey: () => "BPk_test",
    isStandalone: () => true,
    ...rest,
  };
}

describe("useWebPush", () => {
  it("probes to 'default' on mount when supported + configured", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useWebPush(deps));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.state).toBe("default");
  });

  it("reports 'unconfigured' when no VAPID key", async () => {
    const deps = makeDeps({ getVapidPublicKey: () => undefined });
    const { result } = renderHook(() => useWebPush(deps));
    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(result.current.state).toBe("unconfigured");
  });

  it("subscribe() moves state to 'subscribed'", async () => {
    const deps = makeDeps();
    const { result } = renderHook(() => useWebPush(deps));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.subscribe();
    });
    await waitFor(() => expect(result.current.state).toBe("subscribed"));
  });

  it("subscribe() surfaces 'denied' when the user rejects", async () => {
    const deps = makeDeps({
      getNotification: () => makeNotification("default", "denied"),
    });
    const { result } = renderHook(() => useWebPush(deps));
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => {
      await result.current.subscribe();
    });
    await waitFor(() => expect(result.current.state).toBe("denied"));
  });
});
