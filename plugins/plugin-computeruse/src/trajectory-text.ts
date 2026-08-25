/**
 * Validates complete computer-use trajectory text before it reaches an audit
 * record. The boundary rejects malformed UTF-16 instead of repairing or
 * shortening caller-owned evidence, and it never includes the rejected text in
 * its diagnostic context.
 */

import { ElizaError } from "@elizaos/core";

export type ComputerUseTrajectoryTextField =
  | "actionKind"
  | "error"
  | "errorCode"
  | "errorMessage"
  | "goal"
  | "rationale"
  | "ref";

export interface ComputerUseAgentStepTrajectoryPayload {
  step: number;
  goal: string;
  actionKind: string;
  displayId: number;
  rois: number;
  success: boolean;
  error?: string;
  errorCode?: string;
  rationale: string;
}

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Reject malformed Unicode while preserving every valid code unit exactly. */
export function assertComputerUseTrajectoryText(
  field: ComputerUseTrajectoryTextField,
  value: string | undefined,
): void {
  if (value === undefined || isWellFormedUnicode(value)) return;
  throw new ElizaError(
    `Computer-use trajectory field "${field}" contains malformed Unicode`,
    {
      code: "COMPUTERUSE_TRAJECTORY_MALFORMED_UNICODE",
      context: { field },
      severity: "fatal",
    },
  );
}

/** Build the shared Android/desktop agent-step payload after text validation. */
export function buildComputerUseAgentStepTrajectoryPayload(
  event: ComputerUseAgentStepTrajectoryPayload,
): ComputerUseAgentStepTrajectoryPayload {
  assertComputerUseTrajectoryText("goal", event.goal);
  assertComputerUseTrajectoryText("actionKind", event.actionKind);
  assertComputerUseTrajectoryText("error", event.error);
  assertComputerUseTrajectoryText("errorCode", event.errorCode);
  assertComputerUseTrajectoryText("rationale", event.rationale);
  return { ...event };
}
