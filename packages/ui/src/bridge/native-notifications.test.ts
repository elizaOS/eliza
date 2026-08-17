/** Verifies showNativeNotification (android channels) through the package's configured test harness. */
// @vitest-environment jsdom

// Native notification bridge: per-priority Android channel routing, the
// native-only first-that-succeeds chain (web is NOT in it — regression for the
// native-first delivery split), and the separate web fallback's permission +
// silence rules — against mocked Capacitor plugin registries (no device).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { platform, plugins } = vi.hoisted(() => ({
  platform: { value: "android" },
  plugins: {} as Record<string, unknown>,
}));

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: () => platform.value,
    isNativePlatform: () => platform.value !== "web",
  },
}));

vi.mock("./native-plugins", () => ({
  getNativePlugin: (name: string) => plugins[name] ?? {},
}));

import {
  __resetEnsuredChannelsForTests,
  __resetLocalNotificationTapRoutingForTests,
  initLocalNotificationTapRouting,
  showNativeNotification,
  showWebNotification,
} from "./native-notifications";

interface ScheduleArg {
  notifications: Array<{
    id: number;
    title: string;
    body: string;
    channelId?: string;
    extra?: Record<string, unknown>;
  }>;
}
interface ChannelArg {
  id: string;
  name: string;
  importance: number;
  visibility?: number;
}
interface ElizaIntentArg {
  kind: "reminder";
  payload: Record<string, unknown>;
  issuedAtIso: string;
}

function makeLocalNotifications(overrides: Record<string, unknown> = {}) {
  return {
    schedule: vi.fn(async (_options: ScheduleArg) => ({})),
    checkPermissions: vi.fn(async () => ({ display: "granted" })),
    requestPermissions: vi.fn(async () => ({ display: "granted" })),
    createChannel: vi.fn(async (_channel: ChannelArg) => {}),
    ...overrides,
  };
}

beforeEach(() => {
  platform.value = "android";
  for (const key of Object.keys(plugins)) delete plugins[key];
  // Channel cache is module-level; clear it so each case exercises createChannel.
  __resetEnsuredChannelsForTests();
  __resetLocalNotificationTapRoutingForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("showNativeNotification (android channels)", () => {
  it("routes urgent to the max-importance alerts channel", async () => {
    const local = makeLocalNotifications();
    plugins.LocalNotifications = local;
    const result = await showNativeNotification({
      id: "n1",
      title: "Disk full",
      priority: "urgent",
    });
    expect(result).toBe("local");
    expect(local.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "eliza_alerts", importance: 5 }),
    );
    const scheduled = local.schedule.mock.calls[0]?.[0]?.notifications[0];
    expect(scheduled?.channelId).toBe("eliza_alerts");
  });

  it("routes low to the quiet channel (no heads-up, no sound)", async () => {
    const local = makeLocalNotifications();
    plugins.LocalNotifications = local;
    await showNativeNotification({
      id: "n2",
      title: "Backup done",
      priority: "low",
    });
    expect(local.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "eliza_quiet", importance: 2 }),
    );
    const scheduled = local.schedule.mock.calls[0]?.[0]?.notifications[0];
    expect(scheduled?.channelId).toBe("eliza_quiet");
  });

  it("creates each channel once across deliveries", async () => {
    const local = makeLocalNotifications();
    plugins.LocalNotifications = local;
    await showNativeNotification({ id: "a", title: "1", priority: "high" });
    await showNativeNotification({ id: "b", title: "2", priority: "high" });
    const highCalls = local.createChannel.mock.calls.filter(
      ([channel]) => channel.id === "eliza_notifications",
    );
    expect(highCalls).toHaveLength(1);
  });

  it("returns none when permission stays denied and no other channel exists", async () => {
    const local = makeLocalNotifications({
      checkPermissions: vi.fn(async () => ({ display: "denied" })),
      requestPermissions: vi.fn(async () => ({ display: "denied" })),
    });
    plugins.LocalNotifications = local;
    const result = await showNativeNotification({
      id: "n3",
      title: "Hidden",
      priority: "normal",
    });
    expect(result).toBe("none");
    expect(local.schedule).not.toHaveBeenCalled();
  });

  it("returns none (never fabricates 'local') when the Android channel can't be created", async () => {
    // On Android 8+ a post to a nonexistent channel is silently dropped, so
    // claiming "local" here would suppress the store's glass fallback and lose
    // the alert. A createChannel failure must read as unhandled.
    const local = makeLocalNotifications({
      createChannel: vi.fn(async () => {
        throw new Error("channel create failed");
      }),
    });
    plugins.LocalNotifications = local;
    const result = await showNativeNotification({
      id: "n4",
      title: "Dropped",
      priority: "high",
    });
    expect(result).toBe("none");
    expect(local.schedule).not.toHaveBeenCalled();
  });

  it("coalesces the scheduled id by groupKey so a same-group burst replaces in the tray", async () => {
    const local = makeLocalNotifications();
    plugins.LocalNotifications = local;
    await showNativeNotification({
      id: "id-a",
      title: "1 file",
      priority: "high",
      groupKey: "files",
    });
    await showNativeNotification({
      id: "id-b",
      title: "2 files",
      priority: "high",
      groupKey: "files",
    });
    const first = local.schedule.mock.calls[0]?.[0]?.notifications[0]?.id;
    const second = local.schedule.mock.calls[1]?.[0]?.notifications[0]?.id;
    // Same groupKey -> same derived numeric id -> the OS replaces, not stacks.
    expect(first).toBe(second);
    await showNativeNotification({
      id: "id-c",
      title: "other",
      priority: "high",
      groupKey: "other",
    });
    const third = local.schedule.mock.calls[2]?.[0]?.notifications[0]?.id;
    expect(third).not.toBe(first);
  });
});

describe("showNativeNotification (web platform)", () => {
  it("never falls back to the web Notification API — that surface belongs to the caller", async () => {
    // Regression for the native-first delivery split: with no Capacitor
    // channels, the NATIVE chain reports "none" even when the browser
    // Notification API is available; the store then chooses glass banner vs
    // showWebNotification by visibility.
    platform.value = "web";
    const constructed = vi.fn();
    class FakeNotification {
      static permission = "granted";
      constructor(title: string, options?: NotificationOptions) {
        constructed(title, options);
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    const result = await showNativeNotification({
      id: "n4",
      title: "Quiet update",
      priority: "low",
    });
    expect(result).toBe("none");
    expect(constructed).not.toHaveBeenCalled();
  });
});

describe("showNativeNotification (iOS fallback)", () => {
  it("keeps a safe app route for the Capacitor tap listener", async () => {
    platform.value = "ios";
    const local = makeLocalNotifications();
    plugins.LocalNotifications = local;

    const result = await showNativeNotification({
      id: "ios-local",
      title: "Reminder",
      priority: "normal",
      deepLink: "/apps/scheduled?source=notification",
    });

    expect(result).toBe("local");
    expect(local.schedule.mock.calls[0]?.[0]?.notifications[0]?.extra).toEqual({
      deepLink: "/apps/scheduled?source=notification",
    });
  });

  it("does not hand an unsafe tap scheme to native iOS", async () => {
    platform.value = "ios";
    const local = makeLocalNotifications();
    plugins.LocalNotifications = local;

    await showNativeNotification({
      id: "ios-unsafe",
      title: "Reminder",
      priority: "normal",
      deepLink: "javascript:alert(1)",
    });

    expect(
      local.schedule.mock.calls[0]?.[0]?.notifications[0]?.extra,
    ).toBeUndefined();
  });

  it("supplies the required immediate schedule time to ElizaIntent", async () => {
    platform.value = "ios";
    const receiveIntent = vi.fn(async (_intent: ElizaIntentArg) => ({
      accepted: true,
      reason: "scheduled",
    }));
    plugins.ElizaIntent = { receiveIntent };

    const result = await showNativeNotification({
      id: "ios-fallback",
      title: "Reminder",
      body: "Time to stretch",
      priority: "normal",
      deepLink: "/apps/scheduled",
    });

    expect(result).toBe("intent");
    const intent = receiveIntent.mock.calls[0]?.[0];
    expect(intent).toEqual({
      kind: "reminder",
      issuedAtIso: expect.any(String),
      payload: {
        timeIso: expect.any(String),
        title: "Reminder",
        body: "Time to stretch",
        priority: "normal",
        deepLinkOnTap: "elizaos://apps/scheduled",
      },
    });
    expect(intent?.payload.timeIso).toBe(intent?.issuedAtIso);
    expect(Number.isNaN(Date.parse(intent?.issuedAtIso ?? ""))).toBe(false);
  });
});

describe("initLocalNotificationTapRouting", () => {
  it("accepts a native listener handle returned synchronously", async () => {
    const navigate = vi.fn();
    const addListener = vi.fn(
      (
        _event: string,
        callback: (action: {
          actionId: string;
          notification: { extra?: unknown };
        }) => void,
      ) => {
        callback({
          actionId: "tap",
          notification: { extra: { deepLink: "/notifications" } },
        });
        return { remove: async () => {} };
      },
    );

    await expect(
      initLocalNotificationTapRouting({
        getPlugin: () => ({ ...makeLocalNotifications(), addListener }),
        navigate,
      }),
    ).resolves.toBeUndefined();

    expect(addListener).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("/notifications");
  });

  it("deduplicates concurrent initialization before invoking the bridge", async () => {
    const addListener = vi.fn(() => ({ remove: async () => {} }));
    const deps = {
      getPlugin: () => ({ ...makeLocalNotifications(), addListener }),
      navigate: vi.fn(),
    };

    const first = initLocalNotificationTapRouting(deps);
    const second = initLocalNotificationTapRouting(deps);

    expect(first).toBe(second);
    await first;
    expect(addListener).toHaveBeenCalledOnce();
  });

  it("consumes a retained cold-launch tap while the listener is attaching", async () => {
    const navigate = vi.fn();
    const addListener = vi.fn(
      async (
        _event: string,
        callback: (action: {
          actionId: string;
          notification: { extra?: unknown };
        }) => void,
      ) => {
        callback({
          actionId: "tap",
          notification: { extra: { deepLink: "/apps/scheduled" } },
        });
        return { remove: async () => {} };
      },
    );

    await initLocalNotificationTapRouting({
      getPlugin: () => ({ ...makeLocalNotifications(), addListener }),
      navigate,
    });

    expect(navigate).toHaveBeenCalledWith("/apps/scheduled");
  });

  it("routes a retained Capacitor tap through the canonical safe navigator", async () => {
    let listener:
      | ((action: {
          actionId: string;
          notification: { extra?: unknown };
        }) => void)
      | undefined;
    const addListener = vi.fn(
      async (
        _event: string,
        callback: NonNullable<typeof listener>,
      ): Promise<{ remove: () => Promise<void> }> => {
        listener = callback;
        return { remove: async () => {} };
      },
    );
    const navigate = vi.fn();
    const deps = {
      getPlugin: () => ({ ...makeLocalNotifications(), addListener }),
      navigate,
    };

    await initLocalNotificationTapRouting(deps);
    await initLocalNotificationTapRouting(deps);
    listener?.({
      actionId: "tap",
      notification: { extra: { deepLink: "/notifications" } },
    });

    expect(addListener).toHaveBeenCalledOnce();
    expect(addListener).toHaveBeenCalledWith(
      "localNotificationActionPerformed",
      expect.any(Function),
    );
    expect(navigate).toHaveBeenCalledWith("/notifications");
  });

  it("drops dismisses, malformed payloads, and unsafe schemes", async () => {
    let listener:
      | ((action: {
          actionId: string;
          notification: { extra?: unknown };
        }) => void)
      | undefined;
    const addListener = vi.fn(
      async (_event: string, callback: typeof listener) => {
        listener = callback;
        return { remove: async () => {} };
      },
    );
    const navigate = vi.fn();

    await initLocalNotificationTapRouting({
      getPlugin: () => ({ ...makeLocalNotifications(), addListener }),
      navigate,
    });
    listener?.({
      actionId: "dismiss",
      notification: { extra: { deepLink: "/notifications" } },
    });
    listener?.({
      actionId: "tap",
      notification: { extra: { deepLink: "javascript:alert(1)" } },
    });
    listener?.({ actionId: "tap", notification: { extra: "invalid" } });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("can retry listener registration after a native bridge failure", async () => {
    const addListener = vi
      .fn()
      .mockRejectedValueOnce(new Error("bridge unavailable"))
      .mockResolvedValueOnce({ remove: async () => {} });
    const deps = {
      getPlugin: () => ({ ...makeLocalNotifications(), addListener }),
      navigate: vi.fn(),
    };

    await expect(initLocalNotificationTapRouting(deps)).rejects.toThrow(
      "bridge unavailable",
    );
    await expect(
      initLocalNotificationTapRouting(deps),
    ).resolves.toBeUndefined();
    expect(addListener).toHaveBeenCalledTimes(2);
  });

  it("can retry after the native bridge throws synchronously", async () => {
    const addListener = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("native attach threw");
      })
      .mockReturnValueOnce({ remove: async () => {} });
    const deps = {
      getPlugin: () => ({ ...makeLocalNotifications(), addListener }),
      navigate: vi.fn(),
    };

    await expect(initLocalNotificationTapRouting(deps)).rejects.toThrow(
      "native attach threw",
    );
    await expect(
      initLocalNotificationTapRouting(deps),
    ).resolves.toBeUndefined();
    expect(addListener).toHaveBeenCalledTimes(2);
  });
});

describe("showWebNotification", () => {
  it("delivers via the web Notification API with low priority silent", () => {
    platform.value = "web";
    const instances: Array<{ title: string; options?: NotificationOptions }> =
      [];
    class FakeNotification {
      static permission = "granted";
      constructor(title: string, options?: NotificationOptions) {
        instances.push({ title, options });
      }
    }
    vi.stubGlobal("Notification", FakeNotification);
    expect(
      showWebNotification({ id: "n5", title: "Quiet update", priority: "low" }),
    ).toBe(true);
    expect(instances[0]?.options?.silent).toBe(true);

    expect(
      showWebNotification({
        id: "n6",
        title: "Loud update",
        priority: "urgent",
      }),
    ).toBe(true);
    expect(instances[1]?.options?.silent).toBe(false);
  });

  it("returns false when web permission is not granted", () => {
    platform.value = "web";
    vi.stubGlobal(
      "Notification",
      Object.assign(function Notification() {}, { permission: "denied" }),
    );
    expect(
      showWebNotification({ id: "n7", title: "Nope", priority: "normal" }),
    ).toBe(false);
  });

  it("returns false when the Notification API is absent", () => {
    platform.value = "web";
    vi.stubGlobal("Notification", undefined);
    expect(
      showWebNotification({ id: "n8", title: "Nope", priority: "normal" }),
    ).toBe(false);
  });
});
