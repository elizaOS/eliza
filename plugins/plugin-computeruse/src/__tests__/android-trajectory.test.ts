/**
 * WS8 — Android trajectory event emission tests.
 *
 * The trajectory logger reads `computeruse.agent.step` and
 * `computeruse.android.action` events from the structured log stream. We
 * verify both emitters publish the expected shape so the logger contract
 * stays in lock-step with the desktop emitter in `use-computer-agent.ts`.
 */

import { describe, expect, it, vi } from "vitest";
import { logger } from "@elizaos/core";
import {
  emitAndroidAction,
  emitAndroidAgentStep,
} from "../mobile/android-trajectory.js";

describe("emitAndroidAction", () => {
  it("emits a structured `computeruse.android.action` log entry with platform=android", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const payload = emitAndroidAction({
        kind: "tap",
        success: true,
        x: 540,
        y: 960,
        ref: "a0-1",
        rationale: "tap save",
      });
      expect(payload.kind).toBe("tap");
      expect(spy).toHaveBeenCalledTimes(1);
      const [first] = spy.mock.calls;
      const obj = first?.[0] as Record<string, unknown>;
      expect(obj.evt).toBe("computeruse.android.action");
      expect(obj.platform).toBe("android");
      expect(obj.kind).toBe("tap");
      expect(obj.x).toBe(540);
      expect(obj.ref).toBe("a0-1");
    } finally {
      spy.mockRestore();
    }
  });

  it("trims error messages over 256 chars", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const long = "x".repeat(2_000);
      const payload = emitAndroidAction({
        kind: "tap",
        success: false,
        errorCode: "accessibility_unavailable",
        errorMessage: long,
      });
      expect(payload.errorMessage?.length).toBe(256);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({
        evt: "computeruse.android.action",
        platform: "android",
        kind: "tap",
        success: false,
        errorCode: "accessibility_unavailable",
      });
    } finally {
      spy.mockRestore();
    }
  });

  it("does not emit fields that were not supplied", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      emitAndroidAction({ kind: "back", success: true });
      const obj = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(obj.x).toBeUndefined();
      expect(obj.y).toBeUndefined();
      expect(obj.ref).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("emitAndroidAgentStep", () => {
  it("emits a `computeruse.agent.step` entry with platform=android", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      emitAndroidAgentStep({
        step: 3,
        goal: "save the document",
        actionKind: "click",
        displayId: 0,
        rois: 1,
        success: true,
        rationale: "tap save",
      });
      const obj = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(obj.evt).toBe("computeruse.agent.step");
      expect(obj.platform).toBe("android");
      expect(obj.step).toBe(3);
      expect(obj.actionKind).toBe("click");
      expect(obj.success).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("shape matches the desktop emitter in use-computer-agent.ts (same evt key)", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      emitAndroidAgentStep({
        step: 1,
        goal: "g",
        actionKind: "finish",
        displayId: 0,
        rois: 0,
        success: true,
        rationale: "done",
      });
      const obj = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      // The desktop emitter publishes: evt, step, goal, actionKind,
      // displayId, rois, success, error?, rationale. We add platform.
      const expectedKeys = [
        "evt",
        "platform",
        "step",
        "goal",
        "actionKind",
        "displayId",
        "rois",
        "success",
        "error",
        "rationale",
      ];
      for (const k of expectedKeys) {
        expect(k in obj).toBe(true);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
