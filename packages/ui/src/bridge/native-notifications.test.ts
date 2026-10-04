import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetEnsuredChannelsForTests,
  showNativeNotification,
} from "./native-notifications";

const native = vi.hoisted(() => ({
  local: {
    schedule: vi.fn(),
    checkPermissions: vi.fn(),
    createChannel: vi.fn(),
  },
  push: {
    getReminderDataCapabilities: vi.fn(),
    resolveReminderChannel: vi.fn(),
  },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android" },
}));
vi.mock("./native-plugins", () => ({
  getNativePlugin: (name: string) =>
    name === "LocalNotifications" ? native.local : native.push,
}));
vi.mock("../logger.ts", () => ({ logger: { info: vi.fn() } }));
vi.mock("../state/notifications/navigate-deep-link", () => ({
  isSafeDeepLink: () => true,
  navigateDeepLink: vi.fn(),
  readNotificationChatTarget: vi.fn(),
}));

beforeEach(() => {
  vi.resetAllMocks();
  __resetEnsuredChannelsForTests();
  native.local.checkPermissions.mockResolvedValue({ display: "granted" });
  native.push.getReminderDataCapabilities.mockResolvedValue({
    reminderDataNotifications: true,
    reminderChannelSelection: true,
  });
});
const occurrence = {
  id: "due",
  title: "Reminder",
  priority: "high" as const,
  data: { ownerType: "occurrence" },
};

describe("foreground reminder channel compatibility", () => {
  it.each(["eliza_updates", "eliza_notifications"])(
    "uses native authority selection %s",
    async (channelId) => {
      native.push.resolveReminderChannel.mockResolvedValue({
        channelId,
        blocked: false,
      });
      expect(await showNativeNotification(occurrence)).toBe("local");
      expect(native.push.resolveReminderChannel).toHaveBeenCalledWith({
        priority: "high",
        ownerType: "occurrence",
      });
      expect(
        native.local.schedule.mock.calls[0][0].notifications[0].channelId,
      ).toBe(channelId);
    },
  );
  it("keeps muted legacy choices silent and retains the caller fallback", async () => {
    native.push.resolveReminderChannel.mockResolvedValue({
      channelId: "eliza_updates",
      blocked: true,
    });
    expect(await showNativeNotification(occurrence)).toBe("none");
    expect(native.local.schedule).not.toHaveBeenCalled();
    expect(native.local.createChannel).not.toHaveBeenCalled();
  });
  it.each(["normal", "high"] as const)(
    "keeps Calendar %s mapping unchanged",
    async (priority) => {
      native.push.resolveReminderChannel.mockResolvedValue({
        channelId:
          priority === "normal" ? "eliza_updates" : "eliza_notifications",
        blocked: false,
      });
      expect(
        await showNativeNotification({
          ...occurrence,
          priority,
          data: { ownerType: "calendar_event" },
        }),
      ).toBe("local");
      expect(native.push.resolveReminderChannel).toHaveBeenCalledWith({
        priority,
        ownerType: "calendar_event",
      });
      expect(
        native.local.schedule.mock.calls[0][0].notifications[0].channelId,
      ).toBe(priority === "normal" ? "eliza_updates" : "eliza_notifications");
    },
  );
  it("keeps legacy Calendar mapping when native selection is unavailable", async () => {
    native.push.getReminderDataCapabilities.mockResolvedValue({
      reminderDataNotifications: true,
    });
    expect(
      await showNativeNotification({
        ...occurrence,
        data: { ownerType: "calendar_event" },
      }),
    ).toBe("local");
    expect(native.push.resolveReminderChannel).not.toHaveBeenCalled();
    expect(
      native.local.schedule.mock.calls[0][0].notifications[0].channelId,
    ).toBe("eliza_notifications");
  });
  it("does not guess legacy native capability", async () => {
    native.push.getReminderDataCapabilities.mockResolvedValue({
      reminderDataNotifications: true,
    });
    expect(await showNativeNotification(occurrence)).toBe("none");
    expect(native.push.resolveReminderChannel).not.toHaveBeenCalled();
    expect(native.local.schedule).not.toHaveBeenCalled();
  });
  it.each([
    { channelId: "other", blocked: false },
    { channelId: "eliza_updates" },
  ])("rejects invalid native evidence %j", async (result) => {
    native.push.resolveReminderChannel.mockResolvedValue(result);
    expect(await showNativeNotification(occurrence)).toBe("none");
    expect(native.local.schedule).not.toHaveBeenCalled();
  });
  it("retains fallback when native selection fails", async () => {
    native.push.resolveReminderChannel.mockRejectedValue(
      new Error("native unavailable"),
    );
    expect(await showNativeNotification(occurrence)).toBe("none");
    expect(native.local.schedule).not.toHaveBeenCalled();
  });
});
