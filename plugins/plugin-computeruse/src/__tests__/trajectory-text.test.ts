/**
 * Exercises the shared deterministic Android/desktop trajectory-text boundary
 * without mocking the validator that production emitters call.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  assertComputerUseTrajectoryText,
  buildComputerUseAgentStepTrajectoryPayload,
} from "../trajectory-text.js";

describe("computer-use trajectory text boundary", () => {
  it("preserves complete long and astral step fields exactly", () => {
    const complete = `${"trajectory ".repeat(1_000)}🧠 tail`;
    const input = Object.freeze({
      step: 7,
      goal: complete,
      actionKind: complete,
      displayId: 0,
      rois: 2,
      success: false,
      error: complete,
      errorCode: complete,
      rationale: complete,
    });
    const payload = buildComputerUseAgentStepTrajectoryPayload(input);
    expect(payload).not.toBe(input);
    expect(payload).toEqual(input);
  });

  it.each(["\ud800", "\udc00"])(
    "rejects malformed %s without returning repaired evidence",
    (malformed) => {
      let rejected: unknown;
      try {
        assertComputerUseTrajectoryText("error", `before${malformed}after`);
      } catch (error) {
        rejected = error;
      }
      expect(rejected).toBeInstanceOf(ElizaError);
      expect(rejected).toMatchObject({
        code: "COMPUTERUSE_TRAJECTORY_MALFORMED_UNICODE",
        context: { field: "error" },
      });
      expect((rejected as Error).message).not.toContain("before");
    },
  );
});
