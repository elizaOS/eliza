/**
 * Proves the restore-drill nonce is genuinely one-use (#21729 hardening):
 * exercises the real `verifyAndConsumeRestoreTargetIdentity` orchestration
 * against a scripted psql double that models the documented Postgres
 * semantics of `ALTER SYSTEM RESET` + `pg_reload_conf()` (the setting reads
 * back unset once reloaded). No live Postgres is involved — this is a
 * behavioral double of the external tool boundary, not the SQL engine
 * itself; the sibling `apps-tenant-db-recovery.test.ts` states the same
 * posture for the rest of the suite.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TARGET_ID = "drill-11111111-2222-4333-8444-555555555555";
const TARGET_DSN = "postgresql://restore_admin:pw@127.0.0.1:5433/postgres";

/** Minimal fake Postgres session state: one custom setting, reset or not. */
function makeFakeServer(initialTargetId: string | null) {
  let restoreTargetId = initialTargetId;
  return {
    spawnSync(
      command: string,
      args: string[],
    ): { status: number; stdout: string; stderr: string; error: undefined } {
      if (command !== "psql") {
        throw new Error(`unexpected command in nonce double: ${command}`);
      }
      const fileIndex = args.indexOf("--file");
      if (fileIndex === -1) {
        // The authority read: `--command <json_build_object(...)>`.
        return {
          status: 0,
          stdout: JSON.stringify({
            target_id: restoreTargetId,
            existing_roles: [],
          }),
          stderr: "",
          error: undefined,
        };
      }
      // A guarded --file step (only the consume script in this test).
      const setIndex = args.indexOf("--set");
      const expected = args[setIndex + 1]?.split("=")[1];
      const script = readFileSync(args[fileIndex + 1], "utf-8");
      if (restoreTargetId === null || restoreTargetId !== expected) {
        return {
          status: 1,
          stdout: "",
          stderr: "restore target identity mismatch",
          error: undefined,
        };
      }
      if (script.includes("ALTER SYSTEM RESET eliza.restore_target_id")) {
        // Mirrors real Postgres: RESET + reload makes current_setting(..., true)
        // read back unset for every session opened afterward.
        restoreTargetId = null;
      }
      return { status: 0, stdout: "", stderr: "", error: undefined };
    },
  };
}

describe("restore target nonce is genuinely one-use", () => {
  let work: string | undefined;
  let restoreModule: typeof import("node:child_process") | undefined;

  afterEach(async () => {
    if (work !== undefined) rmSync(work, { recursive: true, force: true });
    work = undefined;
    if (restoreModule !== undefined) {
      const { mock } = await import("bun:test");
      mock.module("node:child_process", () => restoreModule);
    }
    restoreModule = undefined;
  });

  test("a second invocation with the same target id fails REFUSED_TARGET_AUTHORITY after the first consumes it", async () => {
    const { mock } = await import("bun:test");
    restoreModule = await import("node:child_process");
    const server = makeFakeServer(TARGET_ID);
    mock.module("node:child_process", () => ({
      ...restoreModule,
      spawnSync: server.spawnSync,
    }));

    const mod = await import(
      `./apps-tenant-db-recovery?nonce-reuse-test=${Date.now()}`
    );
    work = mkdtempSync(join(tmpdir(), "nonce-reuse-test-"));

    const first = mod.verifyAndConsumeRestoreTargetIdentity(
      TARGET_DSN,
      TARGET_ID,
      work,
    );
    expect(first.targetId).toBe(TARGET_ID);

    // The nonce is spent: current_setting now reads unset, so the very next
    // authority read — a re-run of the same drill, an operator mistake, or a
    // process racing the first — fails closed instead of replaying it.
    let reuseError: unknown;
    try {
      mod.verifyAndConsumeRestoreTargetIdentity(TARGET_DSN, TARGET_ID, work);
    } catch (error) {
      reuseError = error;
    }
    expect(reuseError).toBeDefined();
    expect((reuseError as { code?: string }).code).toBe(
      "REFUSED_TARGET_AUTHORITY",
    );
  });

  test("an unrelated concurrent target id is unaffected by another drill's consumption", async () => {
    const { mock } = await import("bun:test");
    restoreModule = await import("node:child_process");
    const otherTargetId = "drill-22222222-3333-4444-8555-666666666666";
    const server = makeFakeServer(otherTargetId);
    mock.module("node:child_process", () => ({
      ...restoreModule,
      spawnSync: server.spawnSync,
    }));

    const mod = await import(
      `./apps-tenant-db-recovery?nonce-independent-test=${Date.now()}`
    );
    work = mkdtempSync(join(tmpdir(), "nonce-independent-test-"));

    let mismatchError: unknown;
    try {
      mod.verifyAndConsumeRestoreTargetIdentity(TARGET_DSN, TARGET_ID, work);
    } catch (error) {
      mismatchError = error;
    }
    expect((mismatchError as { code?: string }).code).toBe(
      "REFUSED_TARGET_AUTHORITY",
    );

    const stillGood = mod.verifyAndConsumeRestoreTargetIdentity(
      TARGET_DSN,
      otherTargetId,
      work,
    );
    expect(stillGood.targetId).toBe(otherTargetId);
  });
});
