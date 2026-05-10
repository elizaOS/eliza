/**
 * `eliza auth` subcommand.
 *
 * Currently exposes:
 *   - `eliza auth reset` — loopback-only recovery path.
 *
 * The reset command revokes every active session. It does NOT touch
 * identities or password hashes — the operator can still log in afterwards
 * via password or SSO.
 *
 * Hard rules:
 *   - Refuse to run when `ELIZA_API_BIND` resolves to a non-loopback host.
 *     A remote attacker over the network has no filesystem on the server,
 *     so combined with the proof step this is a meaningful trust boundary.
 *   - Filesystem proof: print a fresh 32-byte hex challenge token; require
 *     it to be written verbatim into `<state>/auth/RESET_PROOF.txt`; verify
 *     contents and only then proceed. The file is deleted as part of the
 *     successful path.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isLoopbackBindHost, resolveApiBindHost, theme } from "@elizaos/shared";
import type { Command } from "commander";
import { runCommandWithRuntime } from "../cli-utils";

const defaultRuntime = { error: console.error, exit: process.exit };

const RESET_PROOF_FILENAME = "RESET_PROOF.txt";

/**
 * Resolve the eliza state dir without importing service modules.
 * Mirrors the canonical `MILADY_STATE_DIR` > `ELIZA_STATE_DIR` >
 * `~/.${ELIZA_NAMESPACE ?? "eliza"}` precedence in @elizaos/core's
 * `resolveStateDir`.
 */
function resolveElizaStateDir(): string {
  const explicit =
    process.env.MILADY_STATE_DIR?.trim() ||
    process.env.ELIZA_STATE_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const namespace = process.env.ELIZA_NAMESPACE?.trim() || "eliza";
  const home =
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    process.cwd();
  return path.join(home, `.${namespace}`);
}

interface RuntimeAdapter {
  db?: unknown;
  initialize?: () => Promise<void>;
  init?: () => Promise<void>;
  close?: () => Promise<void>;
}

/**
 * Open a pglite-backed AuthStore against the configured state dir. Falls
 * back to throwing if the runtime adapter or schema isn't available — we
 * don't silently no-op a security operation.
 */
async function openAuthStoreFromCli(): Promise<{
  store: import("../../services/auth-store").AuthStore;
  close: () => Promise<void>;
}> {
  const sql = (await import(
    "@elizaos/plugin-sql"
  )) as typeof import("@elizaos/plugin-sql") & {
    createDatabaseAdapter: (
      cfg: { dataDir: string },
      id: `${string}-${string}-${string}-${string}-${string}`,
    ) => unknown;
    DatabaseMigrationService: new () => {
      initializeWithDatabase: (db: unknown) => Promise<void>;
      discoverAndRegisterPluginSchemas: (plugins: unknown[]) => void;
      runAllPluginMigrations: () => Promise<void>;
    };
    plugin: unknown;
  };
  const { createDatabaseAdapter, DatabaseMigrationService, plugin } = sql;
  const { AuthStore } = await import("../../services/auth-store");

  const stateDir = resolveElizaStateDir();
  const dataDir = path.join(stateDir, "db");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
  ) as RuntimeAdapter;
  if (typeof adapter.initialize === "function") {
    await adapter.initialize();
  } else if (typeof adapter.init === "function") {
    await adapter.init();
  }
  if (!adapter.db) {
    throw new Error("CLI auth: adapter has no .db handle");
  }
  const db = adapter.db as import("@elizaos/plugin-sql").DrizzleDatabase;
  const migrations = new DatabaseMigrationService();
  await migrations.initializeWithDatabase(db);
  migrations.discoverAndRegisterPluginSchemas([plugin]);
  await migrations.runAllPluginMigrations();

  return {
    store: new AuthStore(db),
    close: async () => {
      try {
        await adapter.close?.();
      } catch {
        // pglite shutdown is best-effort here.
      }
    },
  };
}

interface ProofChallengeOptions {
  proofPath: string;
  challenge: string;
  reader: () => Promise<string | null>;
  pollIntervalMs?: number;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/**
 * Wait for the operator to write the challenge token into the proof file.
 * Returns true on match, false on timeout or read failure.
 */
async function waitForProofMatch(
  options: ProofChallengeOptions,
): Promise<boolean> {
  const interval = options.pollIntervalMs ?? 500;
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const seen = await options.reader();
    if (seen !== null && seen.trim() === options.challenge) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

interface RunResetParams {
  log?: (line: string) => void;
  /** Override env for tests. */
  env?: NodeJS.ProcessEnv;
  /** Override the proof reader for tests. */
  proofReader?: () => Promise<string | null>;
  /** Pre-resolved store; if omitted the CLI opens its own. */
  store?: import("../../services/auth-store").AuthStore;
  /** Cleanup hook when the CLI opened its own store. */
  cleanup?: () => Promise<void>;
  /** Skip the file-deletion step (tests). */
  skipProofCleanup?: boolean;
  /** Fixed challenge for tests. */
  challenge?: string;
  /** Test override for proof poll interval (ms). */
  proofPollIntervalMs?: number;
  /** Test override for proof challenge timeout (ms). */
  proofTimeoutMs?: number;
}

export interface RunResetResult {
  ok: boolean;
  reason?: "not_loopback" | "proof_failed" | "store_error";
  message?: string;
}

/**
 * Test-callable entry point. Real CLI action wraps this in commander glue.
 */
export async function runElizaAuthReset(
  params: RunResetParams = {},
): Promise<RunResetResult> {
  const log = params.log ?? ((line: string) => console.log(line));
  const env = params.env ?? process.env;
  const bind = resolveApiBindHost(env);
  if (!isLoopbackBindHost(bind)) {
    return {
      ok: false,
      reason: "not_loopback",
      message: `refusing to run: ELIZA_API_BIND=${bind} is not a loopback address`,
    };
  }

  const challenge = params.challenge ?? crypto.randomBytes(32).toString("hex");
  const stateDir = resolveElizaStateDir();
  const proofPath = path.join(stateDir, "auth", RESET_PROOF_FILENAME);

  log(theme.heading("Eliza auth reset"));
  log(
    theme.muted("This revokes every active session. Identities and password"),
  );
  log(theme.muted("hashes are NOT touched — log in afterwards as usual."));
  log("");
  log("To prove filesystem access, write the following 32-byte hex token");
  log(`into ${theme.command(proofPath)} and then re-run this command:`);
  log("");
  log(`  ${theme.command(challenge)}`);
  log("");

  const reader =
    params.proofReader ??
    (async () => {
      try {
        return await fs.readFile(proofPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    });

  const matched = await waitForProofMatch({
    proofPath,
    challenge,
    reader,
    log,
    pollIntervalMs: params.proofPollIntervalMs,
    timeoutMs: params.proofTimeoutMs,
  });
  if (!matched) {
    return {
      ok: false,
      reason: "proof_failed",
      message: "filesystem proof was not written within the timeout",
    };
  }

  let store = params.store;
  let cleanup: (() => Promise<void>) | undefined = params.cleanup;
  if (!store) {
    const opened = await openAuthStoreFromCli();
    store = opened.store;
    cleanup = opened.close;
  }

  const now = Date.now();
  // Revoke every active session by walking owner identities. The schema
  // doesn't index sessions across identities so we iterate.
  const owners = await store.listIdentitiesByKind("owner");
  let revoked = 0;
  for (const ident of owners) {
    revoked += await store.revokeAllSessionsForIdentity(ident.id, now);
  }
  // Machines can have sessions too. Sweep them.
  const machines = await store.listIdentitiesByKind("machine");
  for (const ident of machines) {
    revoked += await store.revokeAllSessionsForIdentity(ident.id, now);
  }

  const { appendAuditEvent } = await import("../../api/auth/index");
  await appendAuditEvent(
    {
      actorIdentityId: null,
      ip: null,
      userAgent: "eliza-cli auth reset",
      action: "auth.reset.cli",
      outcome: "success",
      metadata: { revoked },
    },
    { store },
  );

  if (!params.skipProofCleanup) {
    await fs.rm(proofPath, { force: true });
  }

  if (cleanup) await cleanup();

  log("");
  log(theme.success(`auth reset complete — revoked ${revoked} session(s)`));
  return { ok: true };
}

export function registerAuthCommand(program: Command) {
  const auth = program.command("auth").description("Manage Eliza auth state");

  auth
    .command("reset")
    .description("Revoke all sessions (loopback only)")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const result = await runElizaAuthReset();
        if (!result.ok) {
          console.error(theme.error(result.message ?? "auth reset failed"));
          process.exitCode = 1;
        }
      });
    });
}
