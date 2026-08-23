/**
 * Unit coverage for append-only JSONL audit logging in audit.ts.
 *
 * Tests single-record appending, automatic timestamp injection, nested directory
 * creation, error logging and fail-closed behavior on append failure.
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit.js";

describe("AuditLog", () => {
  let tempDir: string;
  let auditFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vault-audit-test-"));
    auditFilePath = path.join(tempDir, "audit", "vault.jsonl");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("appends audit entries to jsonl file and creates parent directories", async () => {
    const audit = new AuditLog(auditFilePath);

    await audit.record({
      action: "set",
      key: "api.key",
      caller: "cli",
    });

    const content = await fs.readFile(auditFilePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(1);

    const parsed = JSON.parse(lines[0] ?? "");
    expect(parsed.action).toBe("set");
    expect(parsed.key).toBe("api.key");
    expect(parsed.caller).toBe("cli");
    expect(typeof parsed.ts).toBe("number");
    expect(parsed.ts).toBeGreaterThan(0);
  });

  it("preserves explicit timestamps when provided", async () => {
    const audit = new AuditLog(auditFilePath);
    const customTimestamp = 1700000000000;

    await audit.record({
      action: "get",
      key: "db.password",
      ts: customTimestamp,
    });

    const content = await fs.readFile(auditFilePath, "utf8");
    const parsed = JSON.parse(content.trim());
    expect(parsed.ts).toBe(customTimestamp);
    expect(parsed.action).toBe("get");
    expect(parsed.key).toBe("db.password");
  });

  it("appends multiple entries monotonically", async () => {
    const audit = new AuditLog(auditFilePath);

    await audit.record({ action: "set", key: "k1" });
    await audit.record({ action: "remove", key: "k1" });

    const content = await fs.readFile(auditFilePath, "utf8");
    const lines = content.trim().split("\n");
    expect(lines.length).toBe(2);

    const first = JSON.parse(lines[0] ?? "");
    const second = JSON.parse(lines[1] ?? "");
    expect(first.action).toBe("set");
    expect(second.action).toBe("remove");
  });

  it("fails closed, logs warning, and re-throws when appending fails", async () => {
    const warn = vi.fn();
    const logger = { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() };
    const invalidPath = path.join("/dev/null/invalid-dir", "vault.jsonl");
    const audit = new AuditLog(invalidPath, logger);

    await expect(
      audit.record({ action: "set", key: "test" }),
    ).rejects.toThrow();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[vault] failed to append audit record"),
      expect.anything(),
    );
  });
});
