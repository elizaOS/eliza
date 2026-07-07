// @vitest-environment jsdom
/**
 * Contract tests for the web-push subscription manager. Every DOM/global seam
 * (Notification, ServiceWorkerRegistration/PushManager, VAPID key, standalone
 * probe) is injected, so we drive the full state machine —
 * unsupported/unconfigured/denied/default/subscribed — without a real browser
 * push stack.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWebPushState,
  getWebPushSubscription,
  isWebPushSupported,
  subscribeWebPush,
  unsubscribeWebPush,
  urlBase64ToUint8Array,
  type WebPushDeps,
} from "./web-push-subscription";

// jsdom lacks PushManager; define a stub so `isWebPushSupported` can feature
// detect it. Individual tests remove it to exercise the unsupported branch.
const globalWithPush = globalThis as unknown as {
  PushManager?: unknown;
  atob?: (s: string) => string;
};

beforeEach(() => {
  globalWithPush.PushManager = class {};
  if (typeof globalWithPush.atob !== "function") {
    globalWithPush.atob = (s: string) =>
      Buffer.from(s, "base64").toString("binary");
  }
  // `isWebPushSupported` feature-detects `serviceWorker in navigator`; jsdom's
  // navigator has none, so provide a stub for the supported-path tests.
  if (!("serviceWorker" in navigator)) {
    Object.defineProperty(navigator, "serviceWorker", {
      value: { ready: Promise.resolve(undefined) },
      configurable: true,
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeNotification(
  permission: NotificationPermission,
  requested: NotificationPermission = "granted",
): typeof Notification {
  const N = (() => {}) as unknown as typeof Notification;
  Object.defineProperty(N, "permission", {
    value: permission,
    configurable: true,
  });
  (
    N as unknown as { requestPermission: () => Promise<NotificationPermission> }
  ).requestPermission = vi.fn().mockResolvedValue(requested);
  return N;
}

function makeRegistration(existing: unknown = null) {
  const subscribe = vi.fn().mockResolvedValue({ endpoint: "https://push/new" });
  const getSubscription = vi.fn().mockResolvedValue(existing);
  return {
    reg: {
      pushManager: { subscribe, getSubscription },
    } as unknown as ServiceWorkerRegistration,
    subscribe,
    getSubscription,
  };
}

function makeDeps(overrides: Partial<WebPushDeps> = {}): WebPushDeps {
  return {
    getNotification: () => makeNotification("default"),
    getRegistration: async () => makeRegistration().reg,
    getVapidPublicKey: () => "BPk_test_key",
    isStandalone: () => true,
    ...overrides,
  };
}

describe("urlBase64ToUint8Array", () => {
  it("decodes a base64url string with padding restored", () => {
    const bytes = urlBase64ToUint8Array("AQID"); // [1,2,3]
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
});

describe("isWebPushSupported", () => {
  it("is false when not standalone", () => {
    expect(isWebPushSupported(makeDeps({ isStandalone: () => false }))).toBe(
      false,
    );
  });

  it("is false when Notification is absent", () => {
    expect(
      isWebPushSupported(makeDeps({ getNotification: () => undefined })),
    ).toBe(false);
  });

  it("is false when PushManager is undefined", () => {
    globalWithPush.PushManager = undefined;
    expect(isWebPushSupported(makeDeps())).toBe(false);
  });

  it("is true when standalone + Notification + PushManager present", () => {
    expect(isWebPushSupported(makeDeps())).toBe(true);
  });
});

describe("getWebPushState", () => {
  it("returns unsupported when the platform can't push", () => {
    globalWithPush.PushManager = undefined;
    return expect(getWebPushState(makeDeps())).resolves.toBe("unsupported");
  });

  it("returns unconfigured when no VAPID key is set", async () => {
    const state = await getWebPushState(
      makeDeps({ getVapidPublicKey: () => undefined }),
    );
    expect(state).toBe("unconfigured");
  });

  it("returns denied when permission is denied", async () => {
    const state = await getWebPushState(
      makeDeps({ getNotification: () => makeNotification("denied") }),
    );
    expect(state).toBe("denied");
  });

  it("returns subscribed when an active subscription exists", async () => {
    const { reg } = makeRegistration({ endpoint: "https://push/x" });
    const state = await getWebPushState(
      makeDeps({ getRegistration: async () => reg }),
    );
    expect(state).toBe("subscribed");
  });

  it("returns default when supported/configured but not subscribed", async () => {
    const state = await getWebPushState(makeDeps());
    expect(state).toBe("default");
  });
});

describe("subscribeWebPush", () => {
  it("bails as unsupported off-platform", async () => {
    globalWithPush.PushManager = undefined;
    const result = await subscribeWebPush(makeDeps());
    expect(result).toEqual({ state: "unsupported", subscription: null });
  });

  it("bails as unconfigured without a VAPID key", async () => {
    const result = await subscribeWebPush(
      makeDeps({ getVapidPublicKey: () => undefined }),
    );
    expect(result.state).toBe("unconfigured");
  });

  it("prompts for permission then subscribes with userVisibleOnly + key", async () => {
    const { reg, subscribe, getSubscription } = makeRegistration(null);
    const N = makeNotification("default", "granted");
    const result = await subscribeWebPush(
      makeDeps({ getNotification: () => N, getRegistration: async () => reg }),
    );
    expect(
      (N as unknown as { requestPermission: ReturnType<typeof vi.fn> })
        .requestPermission,
    ).toHaveBeenCalled();
    expect(getSubscription).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true }),
    );
    const arg = subscribe.mock.calls[0][0] as {
      applicationServerKey: Uint8Array;
    };
    expect(arg.applicationServerKey).toBeInstanceOf(Uint8Array);
    expect(result.state).toBe("subscribed");
    expect(result.subscription).not.toBeNull();
  });

  it("returns denied when the user rejects the prompt", async () => {
    const N = makeNotification("default", "denied");
    const result = await subscribeWebPush(
      makeDeps({ getNotification: () => N }),
    );
    expect(result).toEqual({ state: "denied", subscription: null });
  });

  it("reuses an existing subscription without re-subscribing", async () => {
    const { reg, subscribe } = makeRegistration({
      endpoint: "https://push/existing",
    });
    const N = makeNotification("granted");
    const result = await subscribeWebPush(
      makeDeps({ getNotification: () => N, getRegistration: async () => reg }),
    );
    expect(subscribe).not.toHaveBeenCalled();
    expect(result.state).toBe("subscribed");
  });
});

describe("unsubscribeWebPush", () => {
  it("unsubscribes and reports the resulting default state", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const getSubscription = vi
      .fn()
      // first call (unsubscribe path) returns the sub, second call (state
      // re-probe) returns null.
      .mockResolvedValueOnce({ endpoint: "https://push/x", unsubscribe })
      .mockResolvedValueOnce(null);
    const reg = {
      pushManager: { getSubscription },
    } as unknown as ServiceWorkerRegistration;
    const state = await unsubscribeWebPush(
      makeDeps({ getRegistration: async () => reg }),
    );
    expect(unsubscribe).toHaveBeenCalled();
    expect(state).toBe("default");
  });

  it("rejects when the browser fails to unsubscribe", async () => {
    const unsubscribe = vi
      .fn()
      .mockRejectedValue(new Error("unsubscribe failed"));
    const getSubscription = vi.fn().mockResolvedValue({
      endpoint: "https://push/x",
      unsubscribe,
    });
    const reg = {
      pushManager: { getSubscription },
    } as unknown as ServiceWorkerRegistration;

    await expect(
      unsubscribeWebPush(makeDeps({ getRegistration: async () => reg })),
    ).rejects.toThrow("unsubscribe failed");
  });

  it("is a no-op returning unsupported off-platform", async () => {
    globalWithPush.PushManager = undefined;
    expect(await unsubscribeWebPush(makeDeps())).toBe("unsupported");
  });
});

describe("getWebPushSubscription", () => {
  it("returns the active subscription", async () => {
    const sub = { endpoint: "https://push/x" };
    const { reg } = makeRegistration(sub);
    expect(
      await getWebPushSubscription(
        makeDeps({ getRegistration: async () => reg }),
      ),
    ).toBe(sub);
  });

  it("returns null off-platform", async () => {
    globalWithPush.PushManager = undefined;
    expect(await getWebPushSubscription(makeDeps())).toBeNull();
  });
});
