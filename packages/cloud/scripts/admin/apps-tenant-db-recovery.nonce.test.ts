/**
 * Proves the restore-drill authority is genuinely one-use after completion
 * (#23453): exercises the real `verifyRestoreAuthority` and
 * `consumeRestoreAuthority` orchestration against a scripted psql double
 * that models the documented Postgres semantics of `ALTER SYSTEM RESET` +
 * `pg_reload_conf()` (settings read back unset once reloaded). No live
 * Postgres is involved — this is a behavioral double of the external tool
 * boundary, not the SQL engine itself; the sibling
 * `apps-tenant-db-recovery.test.ts` states the same posture for the rest of
 * the suite. Live-server coverage of the same sequence lives in
 * `apps-tenant-db-recovery.postgres.test.ts` (gated).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mintRestoreCapability,
  serializeRestoreCapability,
} from "./restore-capability";

const TARGET_ID = "drill-11111111-2222-4333-8444-555555555555";
const TARGET_DSN = "postgresql://restore_admin:***@127.0.0.1:5433/postgres";
const SIGNING_KEY = "nonce-test-key";
const ARCHIVE_SHA = "d".repeat(64);

/**
 * Minimal fake Postgres server: the two twin settings, reset or not. The
 * authority read returns both settings plus the role inventory; guarded
 * --file steps enforce the guard before running; the consume script resets
 * both settings (mirroring real ALTER SYSTEM RESET + pg_reload_conf).
 */
function makeFakeServer(
  initialTargetId: string | null,
  initialCapability: string | null,
) {
  let restoreTargetId = initialTargetId;
  let restoreCapability = initialCapability;
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
            target_id: restoreTargetId ?? "",
            capability: restoreCapability ?? "",
            existing_roles: [],
          }),
          stderr: "",
          error: undefined,
        };
      }
      // A guarded --file step: the guard's twin-setting check runs first.
      const expectedTarget = args.find((a) =>
        a.startsWith("expected_target_id="),
      );
      const expectedCapability = args.find((a) =>
        a.startsWith("expected_capability="),
      );
      const script = readFileSync(args[fileIndex + 1], "utf-8");
      const matches =
        restoreTargetId !== null &&
        restoreCapability !== null &&
        expectedTarget === `expected_target_id=${restoreTargetId}` &&
        expectedCapability === `expected_capability=${restoreCapability}`;
      if (!matches) {
        return {
          status: 1,
          stdout: "",
          stderr: "restore target authority mismatch",
          error: undefined,
        };
      }
      if (script.includes("ALTER SYSTEM RESET eliza.restore_target_id")) {
        // Mirrors real Postgres: RESET + reload makes current_setting(..., true)
        // read back unset for every session opened afterward.
        restoreTargetId = null;
        restoreCapability = null;
      }
      return { status: 0, stdout: "", stderr: "", error: undefined };
    },
  };
}

function mintedCapability() {
  return mintRestoreCapability({
    signingKey: SIGNING_KEY,
    targetId: TARGET_ID,
    archiveSha256: ARCHIVE_SHA,
    expiresAtEpochMs: Date.now() + 3_600_000,
  });
}

describe("restore target authority is one-use after completion", () => {
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

  test("verify succeeds against matching twins; a second drill after consume fails closed", async () => {
    const { mock } = await import("bun:test");
    restoreModule = await import("node:child_process");
    const cap = mintedCapability();
    const envelope = serializeRestoreCapability(cap);
    const server = makeFakeServer(TARGET_ID, envelope);
    mock.module("node:child_process", () => ({
      ...restoreModule,
      spawnSync: server.spawnSync,
    }));

    const mod = await import(
      `./apps-tenant-db-recovery?nonce-reuse-test=${Date.now()}`
    );
    work = mkdtempSync(join(tmpdir(), "nonce-reuse-test-"));

    // Verify passes against the provisioned twins.
    const authority = mod.verifyRestoreAuthority(
      TARGET_DSN,
      TARGET_ID,
      cap,
      SIGNING_KEY,
      Date.now(),
    );
    expect(authority.targetId).toBe(TARGET_ID);

    // Consume spends both settings.
    mod.consumeRestoreAuthority(TARGET_DSN, TARGET_ID, cap, work);

    // The very next verify — a re-run of the completed drill — fails
    // closed: the settings are gone, the nonce is dead.
    let reuseError: unknown;
    try {
      mod.verifyRestoreAuthority(
        TARGET_DSN,
        TARGET_ID,
        cap,
        SIGNING_KEY,
        Date.now(),
      );
    } catch (error) {
      // The expected refusal itself is captured, not swallowed.
      reuseError = error;
    }
    expect(reuseError).toBeDefined();
    expect((reuseError as { code?: string }).code).toBe(
      "REFUSED_TARGET_AUTHORITY",
    );
  });

  test("a mismatched twin (re-provisioned target) is refused before any work", async () => {
    const { mock } = await import("bun:test");
    restoreModule = await import("node:child_process");
    const cap = mintedCapability();
    const otherEnvelope = serializeRestoreCapability(
      mintRestoreCapability({
        signingKey: SIGNING_KEY,
        targetId: TARGET_ID,
        archiveSha256: "e".repeat(64),
        expiresAtEpochMs: Date.now() + 3_600_000,
      }),
    );
    const server = makeFakeServer(TARGET_ID, otherEnvelope);
    mock.module("node:child_process", () => ({
      ...restoreModule,
      spawnSync: server.spawnSync,
    }));

    const mod = await import(
      `./apps-tenant-db-recovery?nonce-mismatch-test=${Date.now()}`
    );

    let mismatchError: unknown;
    try {
      mod.verifyRestoreAuthority(
        TARGET_DSN,
        TARGET_ID,
        cap,
        SIGNING_KEY,
        Date.now(),
      );
    } catch (error) {
      // The expected refusal itself is captured, not swallowed.
      mismatchError = error;
    }
    expect((mismatchError as { code?: string }).code).toBe(
      "REFUSED_TARGET_AUTHORITY",
    );
  });

  test("a failed drill does not consume the twins (idempotent re-run within TTL)", async () => {
    const { mock } = await import("bun:test");
    restoreModule = await import("node:child_process");
    const cap = mintedCapability();
    const envelope = serializeRestoreCapability(cap);
    const server = makeFakeServer(TARGET_ID, envelope);
    mock.module("node:child_process", () => ({
      ...restoreModule,
      spawnSync: server.spawnSync,
    }));

    const mod = await import(
      `./apps-tenant-db-recovery?nonce-recover-test=${Date.now()}`
    );

    // Verify twice without consuming: both succeed — the crash-recovery
    // path never spends the authority.
    expect(
      mod.verifyRestoreAuthority(
        TARGET_DSN,
        TARGET_ID,
        cap,
        SIGNING_KEY,
        Date.now(),
      ).targetId,
    ).toBe(TARGET_ID);
    expect(
      mod.verifyRestoreAuthority(
        TARGET_DSN,
        TARGET_ID,
        cap,
        SIGNING_KEY,
        Date.now(),
      ).targetId,
    ).toBe(TARGET_ID);
  });
});
