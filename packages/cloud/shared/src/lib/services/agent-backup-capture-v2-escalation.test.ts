/**
 * #23235: a capture that keeps failing retryably on the same operation must
 * reach a trusted terminal disposition (with its exact spool cleanup
 * authority) instead of retrying forever, and only after the threshold.
 */

import { describe, expect, test } from "bun:test";
import {
  AGENT_BACKUP_CAPTURE_V2_ESCALATED_CODE,
  escalateRepeatedAgentBackupCaptureV2Failure,
  isTrustedAgentBackupCaptureV2TerminalDisposition,
  normalizeAgentBackupCaptureV2TerminalFailure,
} from "./agent-backup-capture-v2-failure-disposition";
import { AgentBackupCaptureV2PipelineError } from "./agent-backup-capture-v2-pipeline";

const cleanup = Object.freeze({
  organizationId: "10000000-0000-4000-8000-000000000001",
  agentId: "10000000-0000-4000-8000-000000000002",
  backupId: "10000000-0000-4000-8000-000000000003",
  operationId: "10000000-0000-4000-8000-000000000004",
}) as never;

function memoryGateFailure(): Error {
  // The available-memory gate reports an ephemeral, retryable failure.
  return new AgentBackupCaptureV2PipelineError(
    "AGENT_BACKUP_V2_CAPTURE_MEMORY_UNAVAILABLE",
    "Capture archive does not fit available memory",
  );
}

describe("repeated capture failure escalation", () => {
  test("stays retryable below the threshold", () => {
    const error = memoryGateFailure();
    expect(normalizeAgentBackupCaptureV2TerminalFailure(error, cleanup)).toBeUndefined();
    for (const attempts of [0, 1, 7]) {
      expect(
        escalateRepeatedAgentBackupCaptureV2Failure({
          error,
          attempts,
          threshold: 8,
          terminalSpoolCleanup: cleanup,
        }),
      ).toBeUndefined();
    }
  });

  test("escalates to a trusted terminal disposition carrying spool cleanup authority", () => {
    const error = memoryGateFailure();
    const escalated = escalateRepeatedAgentBackupCaptureV2Failure({
      error,
      attempts: 8,
      threshold: 8,
      terminalSpoolCleanup: cleanup,
    });
    expect(escalated).toBeDefined();
    expect(isTrustedAgentBackupCaptureV2TerminalDisposition(escalated)).toBe(true);
    expect(escalated?.code).toBe(AGENT_BACKUP_CAPTURE_V2_ESCALATED_CODE);
    expect(escalated?.terminalSpoolCleanup).toBe(cleanup);
    expect(escalated?.cause).toBe(error);
    expect(escalated?.message).toContain("AGENT_BACKUP_V2_CAPTURE_MEMORY_UNAVAILABLE");
  });

  test("a forged terminal-looking error is never trusted without the policy", () => {
    const forged = Object.assign(new Error("forged"), {
      code: AGENT_BACKUP_CAPTURE_V2_ESCALATED_CODE,
      terminal: true,
    });
    expect(isTrustedAgentBackupCaptureV2TerminalDisposition(forged)).toBe(false);
  });

  test("rejects an unbounded threshold", () => {
    expect(() =>
      escalateRepeatedAgentBackupCaptureV2Failure({
        error: memoryGateFailure(),
        attempts: 1,
        threshold: 0,
        terminalSpoolCleanup: cleanup,
      }),
    ).toThrow(RangeError);
  });
});
