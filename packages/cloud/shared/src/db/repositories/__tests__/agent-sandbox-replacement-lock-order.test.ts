/** Statically guards the account-deletion-safe replacement-start lock order. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("agent sandbox replacement lock order", () => {
  test("starts with organization, then restore lease, sandbox, and attempt", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "agent-sandbox-replacement-attempts.ts"),
      "utf8",
    );
    const start = source.slice(
      source.indexOf("export async function startAgentSandboxReplacementAttemptInTransaction"),
      source.indexOf("async function recordLocatorStageInTransaction"),
    );
    const anchors = [
      ".from(organizations)",
      '.for("key share")',
      ".from(agentBackupRestoreLeases)",
      "lockAndValidateAgentSandboxAuthority(tx",
      ".insert(agentSandboxReplacementAttempts)",
    ];
    let previous = -1;
    for (const anchor of anchors) {
      const index = start.indexOf(anchor, previous + 1);
      expect(index, `missing ordered lock anchor ${anchor}`).toBeGreaterThan(previous);
      previous = index;
    }
  });
});
