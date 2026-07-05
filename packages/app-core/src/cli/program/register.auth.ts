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
import {
  isLoopbackBindHost,
  readAliasedEnv,
  resolveApiBindHost,
  theme,
} from "@elizaos/shared";
import type { Command } from "commander";
import { runCommandWithRuntime } from "../cli-utils";

const defaultRuntime = { error: console.error, exit: process.exit };

const RESET_PROOF_FILENAME = "RESET_PROOF.txt";

/**
 * Resolve the eliza state dir without importing service modules.
 * Mirrors the canonical `ELIZA_STATE_DIR` >
 * `~/.${ELIZA_NAMESPACE ?? "eliza"}` precedence in @elizaos/core's
 * `resolveStateDir`.
 */
function resolveElizaStateDir(): string {
  const explicit = readAliasedEnv("ELIZA_STATE_DIR");
  if (explicit) return path.resolve(explicit);
  const namespace = readAliasedEnv("ELIZA_NAMESPACE") || "eliza";
  const home =
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    process.cwd();
  return path.join(home, `.${namespace}`);
}

interface RuntimeAdapter {
  db?: unknown;
  initialize?: () => Promise<void>;
  close?: () => Promise<void>;
}

interface SqlPluginModule {
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
  const sql = (await import("@elizaos/plugin-sql")) as SqlPluginModule;
  const { createDatabaseAdapter, DatabaseMigrationService, plugin } = sql;
  const { AuthStore } = await import("../../services/auth-store");

  const stateDir = resolveElizaStateDir();
  const dataDir = path.join(stateDir, "db");
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });

  const adapter = createDatabaseAdapter(
    { dataDir },
    "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
  ) as RuntimeAdapter;
  await adapter.initialize?.();
  if (!adapter.db) {
    throw new Error("CLI auth: adapter has no .db handle");
  }
  const db = adapter.db as import("../../services/auth-store").DrizzleDatabase;
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

const DEFAULT_CLOUD_API_BASE = "https://api.elizacloud.ai";

/**
 * Rewrite any elizacloud.ai web host to the API host, mirroring the app's
 * `resolveDirectCloudAuthApiBase`. Keeps a non-elizacloud (self-hosted) base as-is.
 */
function resolveCloudApiBase(input?: string): string {
  const raw = (
    input ||
    process.env.ELIZAOS_CLOUD_BASE_URL ||
    DEFAULT_CLOUD_API_BASE
  ).trim();
  try {
    const u = new URL(raw);
    if (
      /(^|\.)elizacloud\.ai$/.test(u.hostname) &&
      u.hostname !== "api.elizacloud.ai"
    ) {
      u.hostname = "api.elizacloud.ai";
    }
    // Strip a trailing /api/v1 etc. — the SIWE endpoints live at the origin.
    return `${u.protocol}//${u.host}`;
  } catch {
    return raw.replace(/\/+$/, "");
  }
}

/**
 * Build the EIP-4361 (SIWE) message string the way viem's `createSiweMessage`
 * does, so the cloud's `verifyMessage` parses it. `ethers.Wallet.signMessage`
 * applies the EIP-191 personal_sign prefix the server expects.
 */
function buildSiweMessage(args: {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  const head = `${args.domain} wants you to sign in with your Ethereum account:\n${args.address}\n`;
  const body =
    `\nURI: ${args.uri}\n` +
    `Version: ${args.version}\n` +
    `Chain ID: ${args.chainId}\n` +
    `Nonce: ${args.nonce}\n` +
    `Issued At: ${args.issuedAt}`;
  return args.statement
    ? `${head}\n${args.statement}\n${body}`
    : `${head}${body}`;
}

export interface DevWalletLoginResult {
  ok: boolean;
  apiKey?: string;
  address?: string;
  isNewAccount?: boolean;
  organizationId?: string | null;
  savedTo?: string | null;
  message?: string;
}

interface DevWalletLoginParams {
  cloudApiBase?: string;
  /** Persist the minted key as ELIZAOS_CLOUD_API_KEY in the eliza config. Default true. */
  save?: boolean;
  /** Reuse a fixed private key instead of generating one (tests / reproducible runs). */
  privateKey?: string;
  log?: (line: string) => void;
  /** Test override for fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * DEV/TEST cloud login with no browser/OAuth: generate an ephemeral Ethereum
 * wallet, sign the SIWE challenge, and exchange it for an Eliza Cloud API key.
 * Optionally persists the key as ELIZAOS_CLOUD_API_KEY so the local agent uses
 * Eliza Cloud for inference. Test-callable; the CLI action wraps it.
 */
export async function runDevWalletLogin(
  params: DevWalletLoginParams = {},
): Promise<DevWalletLoginResult> {
  const log = params.log ?? ((line: string) => console.log(line));
  const doFetch = params.fetchImpl ?? fetch;
  const apiBase = resolveCloudApiBase(params.cloudApiBase);

  let ethers: typeof import("ethers");
  try {
    ethers = await import("ethers");
  } catch {
    return {
      ok: false,
      message:
        "ethers is required for dev-login but could not be loaded. Install it or run from the workspace.",
    };
  }

  // 1. Nonce — the endpoint can 500/429 transiently under load, so retry.
  type NonceBody = {
    nonce: string;
    domain: string;
    uri: string;
    chainId?: number;
    version?: string;
    statement?: string;
  };
  let nonce: NonceBody | null = null;
  let lastNonceErr = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const nonceRes = await doFetch(
        `${apiBase}/api/auth/siwe/nonce?chainId=1`,
        { headers: { accept: "application/json" } },
      );
      if (nonceRes.ok) {
        const body = (await nonceRes.json()) as NonceBody;
        if (body?.nonce && body?.domain && body?.uri) {
          nonce = body;
          break;
        }
        lastNonceErr = "malformed nonce response";
      } else {
        lastNonceErr = `status ${nonceRes.status}`;
      }
    } catch (err) {
      lastNonceErr = err instanceof Error ? err.message : String(err);
    }
    if (attempt < 5) await new Promise((r) => setTimeout(r, 2500));
  }
  if (!nonce) {
    return {
      ok: false,
      message: `SIWE nonce request failed at ${apiBase} (${lastNonceErr})`,
    };
  }

  // 2. Wallet + signed SIWE message
  const wallet = params.privateKey
    ? new ethers.Wallet(params.privateKey)
    : ethers.Wallet.createRandom();
  const message = buildSiweMessage({
    domain: nonce.domain,
    address: wallet.address,
    statement: nonce.statement,
    uri: nonce.uri,
    version: nonce.version || "1",
    chainId: nonce.chainId || 1,
    nonce: nonce.nonce,
    issuedAt: new Date().toISOString(),
  });
  const signature = await wallet.signMessage(message);

  // 3. Verify → API key
  const verifyRes = await doFetch(`${apiBase}/api/auth/siwe/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  if (!verifyRes.ok) {
    const txt = await verifyRes.text().catch(() => "");
    return {
      ok: false,
      message: `SIWE verify failed (${verifyRes.status}): ${txt.slice(0, 160)}`,
    };
  }
  const verified = (await verifyRes.json()) as {
    apiKey?: string;
    address?: string;
    isNewAccount?: boolean;
    organization?: { id?: string } | null;
    user?: { organization_id?: string } | null;
  };
  const apiKey = verified.apiKey;
  if (!apiKey) {
    return { ok: false, message: "SIWE verify returned no apiKey" };
  }
  const orgId =
    verified.organization?.id ?? verified.user?.organization_id ?? null;

  // 4. Persist (default) so the local agent routes to Eliza Cloud.
  let savedTo: string | null = null;
  if (params.save !== false) {
    try {
      const { resolveConfigPath, loadConfig, saveConfig } = await import(
        "./register.setup"
      );
      const configPath = resolveConfigPath();
      const config = loadConfig(configPath);
      const envSection =
        config.env && typeof config.env === "object"
          ? (config.env as Record<string, string>)
          : {};
      envSection.ELIZAOS_CLOUD_API_KEY = apiKey;
      envSection.ELIZAOS_CLOUD_ENABLED = "true";
      config.env = envSection;
      saveConfig(configPath, config);
      savedTo = configPath;
    } catch (err) {
      log(
        theme.muted(
          `(could not persist key to config: ${err instanceof Error ? err.message : String(err)})`,
        ),
      );
    }
  }

  return {
    ok: true,
    apiKey,
    address: wallet.address,
    isNewAccount: verified.isNewAccount,
    organizationId: orgId,
    savedTo,
  };
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

  auth
    .command("dev-login")
    .description(
      "DEV: generate an ephemeral Ethereum wallet, SIWE sign-in, and mint an Eliza Cloud API key (no browser/OAuth)",
    )
    .option(
      "--cloud <url>",
      "Cloud API base (default https://api.elizacloud.ai or $ELIZAOS_CLOUD_BASE_URL)",
    )
    .option("--no-save", "Print the key only; do not persist it to the config")
    .option("--json", "Emit the result as JSON (for scripting)")
    .action(
      async (opts: { cloud?: string; save?: boolean; json?: boolean }) => {
        await runCommandWithRuntime(defaultRuntime, async () => {
          const result = await runDevWalletLogin({
            cloudApiBase: opts.cloud,
            save: opts.save,
          });
          if (opts.json) {
            console.log(JSON.stringify(result));
            if (!result.ok) process.exitCode = 1;
            return;
          }
          if (!result.ok) {
            console.error(theme.error(result.message ?? "dev-login failed"));
            process.exitCode = 1;
            return;
          }
          console.log(theme.heading("Eliza Cloud dev-login"));
          console.log(
            `${theme.success("✓")} wallet ${theme.command(result.address ?? "?")}${result.isNewAccount ? " (new account)" : ""}`,
          );
          console.log(
            `${theme.success("✓")} API key ${theme.command(result.apiKey ?? "?")}`,
          );
          if (result.organizationId) {
            console.log(`${theme.muted("→")} org ${result.organizationId}`);
          }
          if (result.savedTo) {
            console.log(
              `${theme.success("✓")} saved ELIZAOS_CLOUD_API_KEY to ${theme.command(result.savedTo)} — the agent will use Eliza Cloud`,
            );
          } else {
            console.log(
              `${theme.muted("→")} not saved (use without --no-save to persist, or export ELIZAOS_CLOUD_API_KEY=<key>)`,
            );
          }
        });
      },
    );
}
