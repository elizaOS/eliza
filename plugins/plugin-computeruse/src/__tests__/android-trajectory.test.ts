/**
 * Tests Android trajectory emitters with a mocked structured logger, including
 * Unicode-safe error projection and platform-tagged event parity.
 */

import { logger } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AndroidTrajectoryActionEvent,
  emitAndroidAction,
  emitAndroidAgentStep,
} from "../mobile/android-trajectory.js";

const MAX_ERROR_MESSAGE_LENGTH = 256;

function makeActionEvent(
  overrides: Partial<AndroidTrajectoryActionEvent> = {},
): AndroidTrajectoryActionEvent {
  return {
    kind: "tap",
    success: true,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("emitAndroidAction", () => {
  it("emits a structured `computeruse.android.action` log entry with platform=android", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    const payload = emitAndroidAction({
      kind: "tap",
      success: true,
      x: 540,
      y: 960,
      ref: "a0-1",
      rationale: "tap save",
    });

    expect(payload.kind).toBe("tap");
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: "computeruse.android.action",
        platform: "android",
        kind: "tap",
        x: 540,
        ref: "a0-1",
      }),
      expect.any(String),
    );
  });

  it("preserves absent, empty, short, and exact-limit error messages", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const exact = "a".repeat(MAX_ERROR_MESSAGE_LENGTH);

    expect(emitAndroidAction(makeActionEvent()).errorMessage).toBeUndefined();
    expect(
      emitAndroidAction(makeActionEvent({ errorMessage: "" })).errorMessage,
    ).toBe("");
    expect(
      emitAndroidAction(makeActionEvent({ errorMessage: "short" }))
        .errorMessage,
    ).toBe("short");
    expect(
      emitAndroidAction(makeActionEvent({ errorMessage: exact })).errorMessage,
    ).toBe(exact);
    expect(spy).toHaveBeenCalledTimes(4);
  });

  it("truncates over-limit BMP messages to exactly 256 code units", () => {
    vi.spyOn(logger, "info").mockImplementation(() => logger);
    const payload = emitAndroidAction(
      makeActionEvent({
        success: false,
        errorCode: "accessibility_unavailable",
        errorMessage: "x".repeat(MAX_ERROR_MESSAGE_LENGTH + 1),
      }),
    );

    expect(payload.errorMessage).toBe("x".repeat(MAX_ERROR_MESSAGE_LENGTH));
    expect(payload.errorMessage).toHaveLength(MAX_ERROR_MESSAGE_LENGTH);
  });

  it("backs off rather than splitting an astral pair at the limit", () => {
    vi.spyOn(logger, "info").mockImplementation(() => logger);
    const input = `${"a".repeat(MAX_ERROR_MESSAGE_LENGTH - 1)}\u{1f9e0}z`;

    const payload = emitAndroidAction(makeActionEvent({ errorMessage: input }));

    expect(payload.errorMessage).toBe("a".repeat(MAX_ERROR_MESSAGE_LENGTH - 1));
    expect(payload.errorMessage).toHaveLength(MAX_ERROR_MESSAGE_LENGTH - 1);
  });

  it("normalizes lone surrogates before applying the length limit", () => {
    vi.spyOn(logger, "info").mockImplementation(() => logger);
    const prefix = "a".repeat(MAX_ERROR_MESSAGE_LENGTH - 1);

    expect(
      emitAndroidAction(makeActionEvent({ errorMessage: "ok\ud83e" }))
        .errorMessage,
    ).toBe("ok\ufffd");
    expect(
      emitAndroidAction(makeActionEvent({ errorMessage: "ok\ude00" }))
        .errorMessage,
    ).toBe("ok\ufffd");
    expect(
      emitAndroidAction(makeActionEvent({ errorMessage: `${prefix}\ud83e` }))
        .errorMessage,
    ).toBe(`${prefix}\ufffd`);
    expect(
      emitAndroidAction(makeActionEvent({ errorMessage: `${prefix}\ude00` }))
        .errorMessage,
    ).toBe(`${prefix}\ufffd`);
  });

  it("logs the same normalized error while leaving the input unchanged", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const input = `${"a".repeat(MAX_ERROR_MESSAGE_LENGTH - 1)}\u{1f9e0}z`;
    const event = makeActionEvent({ errorMessage: input });

    const payload = emitAndroidAction(event);

    expect(event.errorMessage).toBe(input);
    expect(payload).not.toBe(event);
    expect(payload.errorMessage).toBe("a".repeat(MAX_ERROR_MESSAGE_LENGTH - 1));
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ errorMessage: payload.errorMessage }),
      expect.any(String),
    );
  });

  it("does not emit fields that were not supplied", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    emitAndroidAction({ kind: "back", success: true });

    expect(spy).toHaveBeenCalledWith(
      {
        evt: "computeruse.android.action",
        platform: "android",
        kind: "back",
        success: true,
      },
      expect.any(String),
    );
  });
});

describe("emitAndroidAgentStep", () => {
  it("emits a `computeruse.agent.step` entry with platform=android", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    emitAndroidAgentStep({
      step: 3,
      goal: "save the document",
      actionKind: "click",
      displayId: 0,
      rois: 1,
      success: true,
      rationale: "tap save",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: "computeruse.agent.step",
        platform: "android",
        step: 3,
        actionKind: "click",
        success: true,
      }),
      expect.any(String),
    );
  });

  it("shape matches the desktop emitter in use-computer-agent.ts (same evt key)", () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => logger);

    emitAndroidAgentStep({
      step: 1,
      goal: "g",
      actionKind: "finish",
      displayId: 0,
      rois: 0,
      success: true,
      rationale: "done",
    });

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        evt: "computeruse.agent.step",
        platform: "android",
        step: 1,
        goal: "g",
        actionKind: "finish",
        displayId: 0,
        rois: 0,
        success: true,
        error: undefined,
        rationale: "done",
      }),
      expect.any(String),
    );
  });
});
