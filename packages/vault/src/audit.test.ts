/**
 * Unit tests for append-only vault operation audit logger.
 */

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "./audit.js";
import type { VaultLogger } from "./types.js";

describe("AuditLog", () => {
  it("appends audit records formatted as JSONL with timestamp", async () => {
    const testDir = join(
      tmpdir(),
      `vault-audit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    const auditFilePath = join(testDir, "vault-audit.jsonl");

    const auditLog = new AuditLog(auditFilePath);

    await auditLog.record({
      op: "read",
      key: "OPENAI_API_KEY",
      source: "cli",
      actor: "user-1",
      success: true,
      ts: 1700000000000,
    });

    await auditLog.record({
      op: "write",
      key: "ANTHROPIC_API_KEY",
      source: "env",
      actor: "user-1",
      success: true,
      ts: 1700000001000,
    });

    const fileContent = await fs.readFile(auditFilePath, "utf8");
    const lines = fileContent.trim().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      ts: 1700000000000,
      op: "read",
      key: "OPENAI_API_KEY",
      source: "cli",
      actor: "user-1",
      success: true,
    });
    expect(JSON.parse(lines[1])).toEqual({
      ts: 1700000001000,
      op: "write",
      key: "ANTHROPIC_API_KEY",
      source: "env",
      actor: "user-1",
      success: true,
    });

    // Cleanup
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("warns and rethrows when writing audit record fails", async () => {
    const invalidPath = "/dev/null/impossible-path/audit.jsonl";
    const mockLogger: VaultLogger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    const auditLog = new AuditLog(invalidPath, mockLogger);

    await expect(
      auditLog.record({
        op: "delete",
        key: "SECRET_KEY",
        source: "api",
        actor: "admin",
        success: false,
      }),
    ).rejects.toThrow();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[vault] failed to append audit record"),
      expect.anything(),
    );
  });
});
