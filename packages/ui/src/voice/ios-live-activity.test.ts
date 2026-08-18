/**
 * Unit coverage for canonical iOS voice Live Activity phase mapping and the
 * serialized start/update/end/relaunch-reconciliation controller.
 */

import { describe, expect, it, vi } from "vitest";
import type { LiveActivityPluginLike } from "../bridge/native-plugins";
import {
  mapContinuousStatusToPhase,
  VoiceLiveActivityController,
} from "./ios-live-activity";

function fakePlugin(
  overrides: Partial<LiveActivityPluginLike> = {},
): LiveActivityPluginLike {
  return {
    isSupported: vi.fn().mockResolvedValue({ supported: true, enabled: true }),
    start: vi.fn().mockResolvedValue({ activityId: "act-1" }),
    update: vi.fn().mockResolvedValue({ updated: true }),
    end: vi.fn().mockResolvedValue({ ended: true }),
    ...overrides,
  } as LiveActivityPluginLike;
}

describe("mapContinuousStatusToPhase", () => {
  it("maps every canonical voice status without inventing dictation state", () => {
    expect(mapContinuousStatusToPhase("idle")).toBe("ready");
    expect(mapContinuousStatusToPhase("listening")).toBe("listening");
    expect(mapContinuousStatusToPhase("transcribing")).toBe("transcribing");
    expect(mapContinuousStatusToPhase("thinking")).toBe("thinking");
    expect(mapContinuousStatusToPhase("interrupting")).toBe("thinking");
    expect(mapContinuousStatusToPhase("speaking")).toBe("speaking");
  });
});

describe("VoiceLiveActivityController", () => {
  it("is inert off iOS", async () => {
    const plugin = fakePlugin();
    const controller = new VoiceLiveActivityController({
      isIos: false,
      plugin,
    });
    await controller.sync({ active: true, phase: "listening" });
    expect(plugin.start).not.toHaveBeenCalled();
  });

  it("starts transcript-free when the canonical session becomes active", async () => {
    const plugin = fakePlugin();
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
      sessionTitle: "Eliza voice",
    });
    await controller.sync({ active: true, phase: "listening" });
    expect(plugin.start).toHaveBeenCalledTimes(1);
    expect(plugin.start).toHaveBeenCalledWith({
      sessionTitle: "Eliza voice",
      phase: "listening",
    });
    expect(plugin.start).not.toHaveBeenCalledWith(
      expect.objectContaining({ transcript: expect.anything() }),
    );
  });

  it("delegates the default title to native localization", async () => {
    const plugin = fakePlugin();
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: true, phase: "ready" });
    expect(plugin.start).toHaveBeenCalledWith({
      sessionTitle: "",
      phase: "ready",
    });
  });

  it("does not start when Live Activities are disabled", async () => {
    const plugin = fakePlugin({
      isSupported: vi
        .fn()
        .mockResolvedValue({ supported: true, enabled: false }),
    });
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: true, phase: "listening" });
    expect(plugin.start).not.toHaveBeenCalled();
  });

  it("pushes only real phase transitions", async () => {
    const plugin = fakePlugin();
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: true, phase: "listening" });
    await controller.sync({ active: true, phase: "listening" });
    expect(plugin.update).not.toHaveBeenCalled();

    await controller.sync({ active: true, phase: "thinking" });
    expect(plugin.update).toHaveBeenCalledTimes(1);
    expect(plugin.update).toHaveBeenCalledWith({
      activityId: "act-1",
      phase: "thinking",
    });
  });

  it("ends an owned session with an explicit terminal phase", async () => {
    const plugin = fakePlugin();
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: true, phase: "listening" });
    await controller.sync({ active: false, phase: "ended" });
    expect(plugin.end).toHaveBeenCalledWith({
      activityId: "act-1",
      phase: "ended",
    });
  });

  it("ends an active failed session so native dismissal owns the error", async () => {
    const plugin = fakePlugin();
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: true, phase: "speaking" });
    await controller.sync({ active: true, phase: "error" });
    expect(plugin.end).toHaveBeenCalledWith({
      activityId: "act-1",
      phase: "error",
    });
    expect(plugin.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "error" }),
    );
  });

  it("clears one orphaned native activity on an inactive relaunch", async () => {
    const plugin = fakePlugin();
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: false, phase: "ended" });
    await controller.sync({ active: false, phase: "ended" });
    expect(plugin.end).toHaveBeenCalledTimes(1);
    expect(plugin.end).toHaveBeenCalledWith({ phase: "ended" });
  });

  it("clears an orphan as ended instead of projecting a stale error", async () => {
    const plugin = fakePlugin();
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: false, phase: "error" });
    expect(plugin.end).toHaveBeenCalledWith({ phase: "ended" });
  });

  it("serializes start before end when toggled rapidly", async () => {
    const order: string[] = [];
    const plugin = fakePlugin({
      start: vi.fn().mockImplementation(async () => {
        order.push("start");
        return { activityId: "act-1" };
      }),
      end: vi.fn().mockImplementation(async () => {
        order.push("end");
        return { ended: true };
      }),
    });
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
    });
    const start = controller.sync({ active: true, phase: "listening" });
    const end = controller.sync({ active: false, phase: "ended" });
    await Promise.all([start, end]);
    expect(order).toEqual(["start", "end"]);
  });

  it("reports a failing ActivityKit call without rejecting voice", async () => {
    const error = new Error("Live Activities disabled");
    const reportError = vi.fn();
    const plugin = fakePlugin({
      start: vi.fn().mockRejectedValue(error),
    });
    const controller = new VoiceLiveActivityController({
      isIos: true,
      plugin,
      reportError,
    });
    await expect(
      controller.sync({ active: true, phase: "listening" }),
    ).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(error);
  });
});
