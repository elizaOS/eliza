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
    getNativeNotificationDeliveryStatus: vi.fn(),
    presentNativeNotification: vi.fn(),
    getReminderDataCapabilities: vi.fn(),
    presentReminderNotification: vi.fn(),
    resolveReminderChannel: vi.fn(),
  },
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android", isNativePlatform: () => true },
}));
vi.mock("./native-plugins", () => ({
  getNativePlugin: (name: string) =>
    name === "LocalNotifications" ? native.local : native.push,
}));
vi.mock("../logger.ts", () => ({ logger: { info: vi.fn() } }));
vi.mock("../state/notifications/navigate-deep-link", () => ({
  isSafeDeepLink: (value: string) =>
    value.startsWith("/") && !value.startsWith("//"),
  navigateDeepLink: vi.fn(),
  readNotificationChatTarget: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
  __resetEnsuredChannelsForTests();
  native.local.checkPermissions.mockResolvedValue({ display: "granted" });
  native.push.getNativeNotificationDeliveryStatus.mockResolvedValue({
    transport: "fcm",
  });
  native.push.getReminderDataCapabilities.mockResolvedValue({
    reminderDataNotifications: true,
    reminderPresentation: true,
  });
});
const request = {
  id: "11111111-1111-4111-8111-111111111111",
  title: "Reminder",
  body: "Stretch shoulders",
  priority: "high" as const,
  category: "reminder" as const,
  groupKey: "reminder:occurrence:owned",
  deepLink: "/chat",
  data: {
    ownerType: "occurrence",
    conversationId: "22222222-2222-4222-8222-222222222222",
    messageId: "11111111-1111-4111-8111-111111111111",
  },
};
describe("one native managed reminder presentation", () => {
  it("shares foreground non-GMS receipts while the background connection is offline", async () => {
    native.push.getNativeNotificationDeliveryStatus.mockResolvedValue({
      transport: "native",
      owner: "a".repeat(64),
      enabled: false,
    });
    native.push.presentNativeNotification.mockResolvedValue({
      notificationId: request.id,
      state: "buffered",
      retained: true,
      presented: false,
      duplicate: false,
    });
    expect(
      await showNativeNotification({
        ...request,
        createdAt: 1791400000000,
        nativeEpoch: "12345678-1234-1234-1234-123456789abc",
        nativeSequence: 42,
        source: "lifeops",
        expectedBase: "http://10.0.0.241:31725",
        expectedOwner: "a".repeat(64),
      }),
    ).toBe("none");
    expect(native.push.presentNativeNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedOwner: "a".repeat(64),
        expectedBase: "http://10.0.0.241:31725",
        notification: expect.objectContaining({
          id: request.id,
          createdAt: 1791400000000,
        nativeEpoch: "12345678-1234-1234-1234-123456789abc",
        nativeSequence: 42,
        }),
      }),
    );
    expect(native.local.schedule).not.toHaveBeenCalled();
    expect(native.push.presentReminderNotification).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "does not present a native record without a valid durable sequence (%s)",
    async (nativeSequence) => {
      native.push.getNativeNotificationDeliveryStatus.mockResolvedValue({ transport: "native", owner: "a".repeat(64) });
      expect(await showNativeNotification({ ...request, createdAt: 1791400000000,
        nativeEpoch: "12345678-1234-1234-1234-123456789abc", nativeSequence,
        expectedBase: "http://10.0.0.241:31725", expectedOwner: "a".repeat(64) })).toBe("none");
      expect(native.push.presentNativeNotification).not.toHaveBeenCalled();
      expect(native.local.schedule).not.toHaveBeenCalled();
    },
  );
  it("does not fork a second LocalNotifications store after native foreground presentation fails", async () => {
    native.push.getNativeNotificationDeliveryStatus.mockResolvedValue({
      transport: "native",
      owner: "a".repeat(64),
    });
    native.push.presentNativeNotification.mockRejectedValue(
      new Error("Native owner changed"),
    );
    await expect(
      showNativeNotification({
        ...request,
        createdAt: 1791400000000,
        nativeEpoch: "12345678-1234-1234-1234-123456789abc",
        nativeSequence: 42,
        expectedBase: "http://10.0.0.241:31725",
        expectedOwner: "a".repeat(64),
      }),
    ).rejects.toThrow("Native owner changed");
    expect(native.local.schedule).not.toHaveBeenCalled();
  });
  it("rejects an old record after a same-base account switch instead of binding it to the new native owner", async () => {
    native.push.getNativeNotificationDeliveryStatus.mockResolvedValue({
      transport: "native",
      owner: "b".repeat(64),
      enabled: true,
    });
    expect(
      await showNativeNotification({
        ...request,
        body: "Previous account record",
        createdAt: 1791400000000,
        nativeEpoch: "12345678-1234-1234-1234-123456789abc",
        nativeSequence: 42,
        expectedBase: "http://10.0.0.241:31725",
        expectedOwner: "a".repeat(64),
      }),
    ).toBe("none");
    expect(native.push.presentNativeNotification).not.toHaveBeenCalled();
    expect(native.local.schedule).not.toHaveBeenCalled();
  });
  it.each(["occurrence", "calendar_event"])(
    "uses common native authority for %s",
    async (ownerType) => {
      native.push.presentReminderNotification.mockResolvedValue({
        accepted: true,
      });
      expect(
        await showNativeNotification({
          ...request,
          data: { ...request.data, ownerType },
        }),
      ).toBe("local");
      expect(native.push.presentReminderNotification).toHaveBeenCalledWith({
        notificationId: request.id,
        groupKey: request.groupKey,
        title: request.title,
        body: request.body,
        priority: "high",
        ownerType,
        deepLink: "/chat",
        conversationId: request.data.conversationId,
        messageId: request.data.messageId,
      });
      expect(native.local.schedule).not.toHaveBeenCalled();
      expect(native.local.createChannel).not.toHaveBeenCalled();
    },
  );
  it.each(["low", "normal", "high", "urgent"] as const)(
    "retains requested tier %s at native boundary",
    async (priority) => {
      native.push.presentReminderNotification.mockResolvedValue({
        accepted: true,
      });
      expect(await showNativeNotification({ ...request, priority })).toBe(
        "local",
      );
      expect(
        native.push.presentReminderNotification.mock.calls[0][0].priority,
      ).toBe(priority);
      expect(native.local.schedule).not.toHaveBeenCalled();
    },
  );
  it.each([false, undefined, "true"])(
    "does not claim unaccepted native result %j",
    async (accepted) => {
      native.push.presentReminderNotification.mockResolvedValue({ accepted });
      expect(await showNativeNotification(request)).toBe("none");
      expect(native.local.schedule).not.toHaveBeenCalled();
    },
  );
  it("keeps old binaries on in-app fallback instead of ungrouped posting", async () => {
    native.push.getReminderDataCapabilities.mockResolvedValue({
      reminderDataNotifications: true,
      reminderChannelSelection: false,
    });
    expect(await showNativeNotification(request)).toBe("none");
    expect(native.push.presentReminderNotification).not.toHaveBeenCalled();
    expect(native.local.schedule).not.toHaveBeenCalled();
  });
  it("does not fall through a native failure to a second reminder builder", async () => {
    native.push.presentReminderNotification.mockRejectedValue(
      new Error("native unavailable"),
    );
    expect(await showNativeNotification(request)).toBe("none");
    expect(native.local.schedule).not.toHaveBeenCalled();
  });
  it.each(["low", "normal", "high"] as const)(
    "keeps legacy Calendar %s delivery",
    async (priority) => {
      native.push.getReminderDataCapabilities.mockResolvedValue({
        reminderDataNotifications: true,
      });
      expect(
        await showNativeNotification({
          ...request,
          priority,
          data: { ownerType: "calendar_event" },
        }),
      ).toBe("local");
      expect(native.local.schedule).toHaveBeenCalledTimes(1);
      expect(native.push.presentReminderNotification).not.toHaveBeenCalled();
    },
  );
  it("keeps muted legacy choices silent and retains the caller fallback", async () => {
    native.push.getReminderDataCapabilities.mockResolvedValue({
      reminderDataNotifications: true,
      reminderPresentation: false,
      reminderChannelSelection: true,
    });
    native.push.resolveReminderChannel.mockResolvedValue({
      channelId: "eliza_updates",
      blocked: true,
    });
    expect(await showNativeNotification(request)).toBe("none");
    expect(native.push.resolveReminderChannel).toHaveBeenCalledWith({
      priority: "high",
      ownerType: "occurrence",
    });
    expect(native.push.presentReminderNotification).not.toHaveBeenCalled();
    expect(native.local.schedule).not.toHaveBeenCalled();
    expect(native.local.createChannel).not.toHaveBeenCalled();
  });
  it.each([
    { channelId: "other", blocked: false },
    { channelId: "eliza_updates" },
  ])("rejects invalid native evidence %j", async (result) => {
    native.push.getReminderDataCapabilities.mockResolvedValue({
      reminderDataNotifications: true,
      reminderPresentation: false,
      reminderChannelSelection: true,
    });
    native.push.resolveReminderChannel.mockResolvedValue(result);
    expect(await showNativeNotification(request)).toBe("none");
    expect(native.push.resolveReminderChannel).toHaveBeenCalledWith({
      priority: "high",
      ownerType: "occurrence",
    });
    expect(native.push.presentReminderNotification).not.toHaveBeenCalled();
    expect(native.local.schedule).not.toHaveBeenCalled();
  });
  it("keeps the legacy quiet occurrence selector fallback", async () => {
    native.push.getReminderDataCapabilities.mockResolvedValue({
      reminderDataNotifications: true,
      reminderChannelSelection: true,
    });
    native.push.resolveReminderChannel.mockResolvedValue({
      channelId: "eliza_updates",
      blocked: false,
    });
    expect(await showNativeNotification(request)).toBe("local");
    expect(
      native.local.schedule.mock.calls[0][0].notifications[0].channelId,
    ).toBe("eliza_updates");
    expect(native.push.presentReminderNotification).not.toHaveBeenCalled();
  });
  it("preserves the selector for older owned calls without category", async () => {
    native.push.getReminderDataCapabilities.mockResolvedValue({
      reminderDataNotifications: true,
      reminderPresentation: true,
      reminderChannelSelection: true,
    });
    native.push.resolveReminderChannel.mockResolvedValue({
      channelId: "eliza_updates",
      blocked: false,
    });
    expect(
      await showNativeNotification({ ...request, category: undefined }),
    ).toBe("local");
    expect(
      native.local.schedule.mock.calls[0][0].notifications[0].channelId,
    ).toBe("eliza_updates");
    expect(native.push.presentReminderNotification).not.toHaveBeenCalled();
  });
  it("preserves unrelated local notification behavior", async () => {
    expect(await showNativeNotification({ ...request, data: {} })).toBe(
      "local",
    );
    expect(native.push.presentReminderNotification).not.toHaveBeenCalled();
    expect(native.local.schedule).toHaveBeenCalledTimes(1);
  });
});
