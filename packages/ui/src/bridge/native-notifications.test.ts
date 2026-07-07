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
  showNativeNotification,
  showWebNotification,
} from "./native-notifications";

interface ScheduleArg {
  notifications: Array<{
    id: number;
    title: string;
    body: string;
    channelId?: string;
  }>;
}
interface ChannelArg {
  id: string;
  name: string;
  importance: number;
  visibility?: number;
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
