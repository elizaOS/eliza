/**
 * WS8 — Android trajectory event emission tests.
 *
 * The trajectory logger reads `computeruse.agent.step` and
 * `computeruse.android.action` events from the structured log stream. We
 * verify both emitters publish the expected shape so the logger contract
 * stays in lock-step with the desktop emitter in `use-computer-agent.ts`.
 */

import { ElizaError, logger } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
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

  it("preserves complete long error messages in the payload and structured log", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const long = "x".repeat(2_000);
      const payload = emitAndroidAction({
        kind: "tap",
        success: false,
        errorCode: "accessibility_unavailable",
        errorMessage: long,
      });
      expect(payload.errorMessage).toBe(long);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({
        evt: "computeruse.android.action",
        platform: "android",
        kind: "tap",
        success: false,
        errorCode: "accessibility_unavailable",
        errorMessage: long,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it.each([undefined, "", "short bridge failure"])(
    "preserves absent, empty, and short action errors exactly: %s",
    (errorMessage) => {
      const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
      try {
        const event = {
          kind: "tap" as const,
          success: false,
          ...(errorMessage === undefined ? {} : { errorMessage }),
        };
        const payload = emitAndroidAction(event);
        const structured = spy.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(payload).toEqual(event);
        expect("errorMessage" in payload).toBe(errorMessage !== undefined);
        expect("errorMessage" in structured).toBe(errorMessage !== undefined);
        expect(structured.errorMessage).toBe(errorMessage);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it("preserves every well-formed action text field and leaves the input unchanged", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const complete = `${"context ".repeat(400)}🧠 tail`;
      const event = Object.freeze({
        kind: "tap" as const,
        success: false,
        errorCode: complete,
        errorMessage: complete,
        ref: complete,
        rationale: complete,
      });
      const payload = emitAndroidAction(event);
      expect(payload).not.toBe(event);
      expect(payload).toEqual(event);
      expect(spy.mock.calls[0]?.[0]).toMatchObject(event);
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["errorCode", "errorMessage", "ref", "rationale"] as const)(
    "rejects malformed Unicode in action %s without logging",
    (field) => {
      for (const malformed of ["before\ud800after", "before\udc00after"]) {
        const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
        try {
          let thrown: unknown;
          try {
            emitAndroidAction({
              kind: "tap",
              success: false,
              [field]: malformed,
            });
          } catch (error) {
            thrown = error;
          }
          expect(thrown).toBeInstanceOf(ElizaError);
          expect(thrown).toMatchObject({
            code: "COMPUTERUSE_TRAJECTORY_MALFORMED_UNICODE",
            context: { field },
          });
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      }
    },
  );

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

  it("preserves complete long agent-step errors", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const error = "android bridge failure ".repeat(200);
      const payload = emitAndroidAgentStep({
        step: 4,
        goal: "save the document",
        actionKind: "click",
        displayId: 0,
        rois: 1,
        success: false,
        error,
        rationale: "tap save",
      });
      expect(payload.error).toBe(error);
      expect(spy.mock.calls[0]?.[0]).toMatchObject({ error });
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["goal", "actionKind", "error", "errorCode", "rationale"] as const)(
    "rejects malformed Unicode in agent-step %s without logging",
    (field) => {
      for (const malformed of ["before\ud800after", "before\udc00after"]) {
        const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
        try {
          const event = {
            step: 1,
            goal: "save",
            actionKind: "click",
            displayId: 0,
            rois: 1,
            success: false,
            error: "bridge failed",
            errorCode: "bridge_error",
            rationale: "tap save",
            [field]: malformed,
          };
          expect(() => emitAndroidAgentStep(event)).toThrowError(ElizaError);
          expect(spy).not.toHaveBeenCalled();
        } finally {
          spy.mockRestore();
        }
      }
    },
  );

  it("shape matches the desktop emitter in use-computer-agent.ts (same evt key)", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      emitAndroidAgentStep({
        step: 1,
        goal: "g",
        actionKind: "finish",
        displayId: 0,
        rois: 0,
        success: false,
        error: "bridge failed",
        errorCode: "bridge_error",
        rationale: "done",
      });
      const obj = spy.mock.calls[0]?.[0] as Record<string, unknown>;
      // The desktop emitter publishes: evt, step, goal, actionKind,
      // displayId, rois, success, error?, errorCode?, rationale. We add platform.
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
        "errorCode",
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
