/**
 * Tests for seedClaudeBypassPermissionsAck — pre-acknowledges the
 * --dangerously-skip-permissions one-time confirmation dialog by writing
 * `bypassPermissionsAcknowledged: true` to ~/.claude.json.
 *
 * Fixes: https://github.com/ai16z/eliza/issues/7365
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("seedClaudeBypassPermissionsAck", () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "bypass-perm-test-"));
    configPath = path.join(tmpDir, ".claude.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates config file with bypassPermissionsAcknowledged when it does not exist", async () => {
    const { seedClaudeBypassPermissionsAckForTesting } = await import(
      "../services/pty-service.js"
    );

    await seedClaudeBypassPermissionsAckForTesting(configPath);

    const result = JSON.parse(readFileSync(configPath, "utf8"));
    expect(result.bypassPermissionsAcknowledged).toBe(true);
  });

  it("adds bypassPermissionsAcknowledged to existing config without clobbering other keys", async () => {
    const { seedClaudeBypassPermissionsAckForTesting } = await import(
      "../services/pty-service.js"
    );

    writeFileSync(
      configPath,
      JSON.stringify({
        projects: { "/tmp/work": { hasTrustDialogAccepted: true } },
        someOtherKey: "preserved",
      }),
    );

    await seedClaudeBypassPermissionsAckForTesting(configPath);

    const result = JSON.parse(readFileSync(configPath, "utf8"));
    expect(result.bypassPermissionsAcknowledged).toBe(true);
    expect(result.someOtherKey).toBe("preserved");
    expect(result.projects["/tmp/work"].hasTrustDialogAccepted).toBe(true);
  });

  it("is a no-op when bypassPermissionsAcknowledged is already true", async () => {
    const { seedClaudeBypassPermissionsAckForTesting } = await import(
      "../services/pty-service.js"
    );

    const original = JSON.stringify(
      { bypassPermissionsAcknowledged: true, other: "data" },
      null,
      2,
    );
    writeFileSync(configPath, original);

    await seedClaudeBypassPermissionsAckForTesting(configPath);

    // File should not be rewritten (content unchanged)
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("handles concurrent calls without losing data", async () => {
    const { seedClaudeBypassPermissionsAckForTesting } = await import(
      "../services/pty-service.js"
    );

    // Call multiple times concurrently — should not corrupt the file
    await Promise.all([
      seedClaudeBypassPermissionsAckForTesting(configPath),
      seedClaudeBypassPermissionsAckForTesting(configPath),
      seedClaudeBypassPermissionsAckForTesting(configPath),
    ]);

    const result = JSON.parse(readFileSync(configPath, "utf8"));
    expect(result.bypassPermissionsAcknowledged).toBe(true);
  });
});
