import { describe, expect, test } from "bun:test";
import { ElizaError } from "@elizaos/core";
import {
  createAgentBackupCaptureV2ExecutorError,
  isTrustedAgentBackupCaptureV2TerminalDisposition,
  normalizeAgentBackupCaptureV2TerminalFailure,
} from "./agent-backup-capture-v2-failure-disposition";

describe("capture-v2 failure disposition", () => {
  test("generic executor factory cannot brand stale authority even with cleanup-shaped input", () => {
    const generic = createAgentBackupCaptureV2ExecutorError(
      "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
      "generic factory has no resolver provenance",
    );
    const normalized = normalizeAgentBackupCaptureV2TerminalFailure(generic, {
      organizationId: "00000000-0000-4000-8000-000000000001",
      agentId: "00000000-0000-4000-8000-000000000002",
      backupId: "00000000-0000-4000-8000-000000000003",
      operationId: "00000000-0000-4000-8000-000000000004",
      activationGeneration: "00000000-0000-4000-8000-000000000005",
      lifecycleRevision: "7",
      requestSha256: "a".repeat(64),
      authoritySha256: "b".repeat(64),
      runtimePrincipalSha256: "c".repeat(64),
    });

    expect(generic.terminal).toBe(false);
    expect(isTrustedAgentBackupCaptureV2TerminalDisposition(generic)).toBe(false);
    expect(normalized).toBeUndefined();
  });

  test("does not trust a publicly constructible typed stale-authority failure", () => {
    const normalized = normalizeAgentBackupCaptureV2TerminalFailure(
      new ElizaError("Reserved source generation changed", {
        code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
        severity: "fatal",
      }),
    );

    expect(normalized).toBeUndefined();
    expect(isTrustedAgentBackupCaptureV2TerminalDisposition(normalized)).toBe(false);
  });

  test("does not trust a plain error that forges the stale authority code", () => {
    const forged = Object.assign(new Error("forged stale authority"), {
      code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
      terminal: true,
    });

    expect(normalizeAgentBackupCaptureV2TerminalFailure(forged)).toBeUndefined();
  });

  test("requires fatal severity on the typed stale authority error", () => {
    const retryable = new ElizaError("Authority lookup can be retried", {
      code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_STALE",
      severity: "ephemeral",
    });

    expect(normalizeAgentBackupCaptureV2TerminalFailure(retryable)).toBeUndefined();
  });

  test("does not make arbitrary typed runtime failures terminal", () => {
    const unrelated = new ElizaError("Transient authority lookup failed", {
      code: "AGENT_BACKUP_V3_RUNTIME_AUTHORITY_UNAVAILABLE",
      severity: "ephemeral",
    });

    expect(normalizeAgentBackupCaptureV2TerminalFailure(unrelated)).toBeUndefined();
  });
});
