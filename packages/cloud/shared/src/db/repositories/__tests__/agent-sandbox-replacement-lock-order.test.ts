/** Statically guards the account-deletion-safe replacement-start lock order. */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("agent sandbox replacement lock order", () => {
  test("starts with organization, ordered restore authority, sandbox, and post-wait clocks", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "agent-sandbox-replacement-attempts.ts"),
      "utf8",
    );
    const restoreAuthority = source.slice(
      source.indexOf("async function lockRestoreStartAuthority"),
      source.indexOf("export async function startAgentSandboxReplacementAttemptInTransaction"),
    );
    const restoreAnchors = [
      ".from(agentSandboxBackups)",
      ".from(agentBackupRestoreOperations)",
      ".from(agentBackupRestoreLeases)",
    ];
    let previous = -1;
    for (const anchor of restoreAnchors) {
      const index = restoreAuthority.indexOf(anchor, previous + 1);
      expect(index, `missing ordered restore-authority anchor ${anchor}`).toBeGreaterThan(previous);
      previous = index;
    }

    const start = source.slice(
      source.indexOf("export async function startAgentSandboxReplacementAttemptInTransaction"),
      source.indexOf("function assertReplacementAdmissionPreState"),
    );
    const anchors = [
      ".from(organizations)",
      '.for("key share")',
      "lockRestoreStartAuthority(tx, validated)",
      "await assertRestoreLeaseNotExpired(tx, restoreLeaseExpiresAt, validated)",
      "lockAndValidateAgentSandboxAuthority(tx",
      "await assertRestoreLeaseNotExpired(tx, restoreLeaseExpiresAt, validated)",
      ".insert(agentSandboxReplacementAttempts)",
      "await assertRestoreLeaseNotExpired(tx, restoreLeaseExpiresAt, validated)",
    ];
    previous = -1;
    for (const anchor of anchors) {
      const index = start.indexOf(anchor, previous + 1);
      expect(index, `missing ordered lock anchor ${anchor}`).toBeGreaterThan(previous);
      previous = index;
    }
  });

  test("atomic admission pre-acquires organization and restore authority before the sandbox", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "agent-sandbox-replacement-attempts.ts"),
      "utf8",
    );
    const admission = source.slice(
      source.indexOf("export async function admitAndStartAgentSandboxReplacementInTransaction"),
      source.indexOf("async function lockReplacementCapacityNode"),
    );
    const anchors = [
      ".from(organizations)",
      '.for("key share")',
      "lockRestoreStartAuthority(tx, validatedStart)",
      "lockAgentSandboxAuthority(tx, admission)",
      "startAgentSandboxReplacementAttemptInTransaction(tx, startInput)",
    ];
    let previous = -1;
    for (const anchor of anchors) {
      const index = admission.indexOf(anchor, previous + 1);
      expect(index, `missing ordered admission anchor ${anchor}`).toBeGreaterThan(previous);
      previous = index;
    }
  });

  test("runs the real PostgreSQL regression as a required hosted gate", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../../../../../../.github/workflows/cloud-tests.yml"),
      "utf8",
    );
    expect(workflow).toContain(
      "packages/cloud/shared/src/db/repositories/__tests__/agent-sandbox-replacement-account-deletion-locks.integration.test.ts",
    );
    expect(workflow).toContain('REQUIRE_REAL_POSTGRES_REPLACEMENT_LOCK_TESTS: "1"');
  });
});
