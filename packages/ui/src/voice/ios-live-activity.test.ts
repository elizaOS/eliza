/**
 * Unit coverage for the iOS Live Activity driver: pure status→phase mapping,
 * transcript trimming, and the controller's start/update/end sequencing against
 * a fake ActivityKit bridge (throttle, disabled-support, off-iOS no-op,
 * start-before-end ordering).
 */

import { describe, expect, it, vi } from "vitest";
import type { LiveActivityPluginLike } from "../bridge/native-plugins";
import {
  DictationLiveActivityController,
  mapContinuousStatusToPhase,
  truncateTranscriptSnippet,
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
  it("maps each continuous-chat status to a dictation phase", () => {
    expect(mapContinuousStatusToPhase("listening")).toBe("recording");
    expect(mapContinuousStatusToPhase("thinking")).toBe("thinking");
    expect(mapContinuousStatusToPhase("interrupting")).toBe("thinking");
    expect(mapContinuousStatusToPhase("speaking")).toBe("speaking");
    expect(mapContinuousStatusToPhase("idle")).toBe("transcribing");
  });
});

describe("truncateTranscriptSnippet", () => {
  it("collapses whitespace and keeps the tail", () => {
    expect(truncateTranscriptSnippet("  hello   world  ")).toBe("hello world");
    const long = "a".repeat(200);
    const trimmed = truncateTranscriptSnippet(long, 10);
    expect(trimmed).toBe(`…${"a".repeat(10)}`);
    expect(trimmed.length).toBe(11);
  });
});

describe("DictationLiveActivityController", () => {
  it("is inert off iOS", async () => {
    const plugin = fakePlugin();
    const controller = new DictationLiveActivityController({
      isIos: false,
      plugin,
    });
    await controller.sync({ active: true, phase: "recording", transcript: "hi" });
    expect(plugin.start).not.toHaveBeenCalled();
  });

  it("starts an activity when the session goes active", async () => {
    const plugin = fakePlugin();
    const controller = new DictationLiveActivityController({
      isIos: true,
      plugin,
      sessionTitle: "Dictation",
    });
    await controller.sync({
      active: true,
      phase: "recording",
      transcript: "hello",
    });
    expect(plugin.start).toHaveBeenCalledTimes(1);
    expect(plugin.start).toHaveBeenCalledWith({
      sessionTitle: "Dictation",
      phase: "recording",
      transcript: "hello",
    });
  });

  it("does not start when Live Activities are disabled", async () => {
    const plugin = fakePlugin({
      isSupported: vi
        .fn()
        .mockResolvedValue({ supported: true, enabled: false }),
    });
    const controller = new DictationLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: true, phase: "recording", transcript: "x" });
    expect(plugin.start).not.toHaveBeenCalled();
  });

  it("pushes phase changes immediately but throttles transcript churn", async () => {
    const plugin = fakePlugin();
    let clock = 1000;
    const controller = new DictationLiveActivityController({
      isIos: true,
      plugin,
      now: () => clock,
      minUpdateIntervalMs: 800,
    });
    await controller.sync({ active: true, phase: "recording", transcript: "a" });

    // Transcript-only change within the throttle window: skipped.
    clock = 1200;
    await controller.sync({ active: true, phase: "recording", transcript: "ab" });
    expect(plugin.update).not.toHaveBeenCalled();

    // Phase change: pushed immediately regardless of the window.
    clock = 1300;
    await controller.sync({
      active: true,
      phase: "thinking",
      transcript: "ab",
    });
    expect(plugin.update).toHaveBeenCalledTimes(1);
    expect(plugin.update).toHaveBeenLastCalledWith({
      activityId: "act-1",
      phase: "thinking",
      transcript: "ab",
    });

    // Transcript-only change past the window: pushed.
    clock = 2200;
    await controller.sync({
      active: true,
      phase: "thinking",
      transcript: "abc",
    });
    expect(plugin.update).toHaveBeenCalledTimes(2);
  });

  it("ends the activity when the session stops", async () => {
    const plugin = fakePlugin();
    const controller = new DictationLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: true, phase: "recording", transcript: "" });
    await controller.sync({ active: false, phase: "recording", transcript: "" });
    expect(plugin.end).toHaveBeenCalledWith({ activityId: "act-1" });
  });

  it("does not end when there is no active activity", async () => {
    const plugin = fakePlugin();
    const controller = new DictationLiveActivityController({
      isIos: true,
      plugin,
    });
    await controller.sync({ active: false, phase: "recording", transcript: "" });
    expect(plugin.end).not.toHaveBeenCalled();
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
    const controller = new DictationLiveActivityController({
      isIos: true,
      plugin,
    });
    const p1 = controller.sync({
      active: true,
      phase: "recording",
      transcript: "",
    });
    const p2 = controller.sync({
      active: false,
      phase: "recording",
      transcript: "",
    });
    await Promise.all([p1, p2]);
    expect(order).toEqual(["start", "end"]);
  });

  it("swallows a failing ActivityKit call without rejecting", async () => {
    const plugin = fakePlugin({
      start: vi.fn().mockRejectedValue(new Error("Live Activities disabled")),
    });
    const controller = new DictationLiveActivityController({
      isIos: true,
      plugin,
    });
    await expect(
      controller.sync({ active: true, phase: "recording", transcript: "" }),
    ).resolves.toBeUndefined();
  });
});
