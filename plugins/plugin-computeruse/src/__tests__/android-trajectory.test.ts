/**
 * WS8 — Android trajectory event emission tests.
 *
 * The trajectory logger reads `computeruse.agent.step` and
 * `computeruse.android.action` events from the structured log stream. We
 * verify both emitters publish the expected shape so the logger contract
 * stays in lock-step with the desktop emitter in `use-computer-agent.ts`.
 */

import { logger } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  type AndroidTrajectoryActionEvent,
  emitAndroidAction,
  emitAndroidAgentStep,
} from "../mobile/android-trajectory.js";

const ERROR_MESSAGE_MAX_CODE_UNITS = 256;
const REPLACEMENT_CHARACTER = "�";

function isWellFormed(text: string): boolean {
  return (
    (text as unknown as { isWellFormed?: () => boolean }).isWellFormed?.() ??
    !/[\uD800-\uDFFF]/u.test(text)
  );
}

function emitFailure(errorMessage?: string): {
  event: AndroidTrajectoryActionEvent;
  payload: AndroidTrajectoryActionEvent;
  logged: Record<string, unknown>;
} {
  const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
  try {
    const event: AndroidTrajectoryActionEvent = {
      kind: "tap",
      success: false,
      errorCode: "accessibility_unavailable",
      errorMessage,
    };
    const payload = emitAndroidAction(event);
    const logged = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    return { event, payload, logged };
  } finally {
    spy.mockRestore();
  }
}

function expectProjectedError(
  input: string | undefined,
  expected: string | undefined,
): void {
  const { event, payload, logged } = emitFailure(input);
  expect(event.errorMessage).toBe(input);
  expect(payload.errorMessage).toBe(expected);
  expect(logged.errorMessage).toBe(expected);
  if (expected !== undefined) {
    expect(isWellFormed(expected)).toBe(true);
    expect(expected.length).toBeLessThanOrEqual(ERROR_MESSAGE_MAX_CODE_UNITS);
  }
}

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

  it.each([
    ["empty", "", ""],
    ["short", "bridge 🧠 failed", "bridge 🧠 failed"],
  ])("preserves a %s error projection", (_, input, expected) => {
    expectProjectedError(input, expected);
  });

  it("keeps an absent error message absent", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    try {
      const event: AndroidTrajectoryActionEvent = {
        kind: "tap",
        success: false,
        errorCode: "accessibility_unavailable",
      };
      const payload = emitAndroidAction(event);
      const logged = spy.mock.calls.at(-1)?.[0] as Record<string, unknown>;

      expect(Object.hasOwn(event, "errorMessage")).toBe(false);
      expect(Object.hasOwn(payload, "errorMessage")).toBe(false);
      expect(Object.hasOwn(logged, "errorMessage")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("preserves an exact-cap astral error without truncating", () => {
    const input = `${"a".repeat(ERROR_MESSAGE_MAX_CODE_UNITS - 2)}🧠`;
    expect(input.length).toBe(ERROR_MESSAGE_MAX_CODE_UNITS);
    expectProjectedError(input, input);
  });

  it("caps a plain max+1 error at 256 code units", () => {
    const input = "a".repeat(ERROR_MESSAGE_MAX_CODE_UNITS + 1);
    expectProjectedError(input, "a".repeat(ERROR_MESSAGE_MAX_CODE_UNITS));
  });

  it("backs off when an astral pair crosses the cut", () => {
    const input = `${"a".repeat(ERROR_MESSAGE_MAX_CODE_UNITS - 1)}🧠z`;
    expectProjectedError(input, "a".repeat(ERROR_MESSAGE_MAX_CODE_UNITS - 1));
  });

  it.each([
    ["lone high surrogate", "\uD83E"],
    ["lone low surrogate", "\uDDE0"],
  ])("normalizes a short %s", (_, lone) => {
    expectProjectedError(
      `left${lone}right`,
      `left${REPLACEMENT_CHARACTER}right`,
    );
  });

  it.each([
    ["lone high surrogate", "\uD83E"],
    ["lone low surrogate", "\uDDE0"],
  ])("normalizes a long %s before truncating", (_, lone) => {
    const input = `${"a".repeat(ERROR_MESSAGE_MAX_CODE_UNITS - 1)}${lone}z`;
    expectProjectedError(
      input,
      `${"a".repeat(ERROR_MESSAGE_MAX_CODE_UNITS - 1)}${REPLACEMENT_CHARACTER}`,
    );
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
