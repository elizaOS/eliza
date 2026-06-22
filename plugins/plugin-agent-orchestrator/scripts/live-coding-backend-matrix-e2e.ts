/**
 * LIVE coding-backend completion MATRIX — one harness, three backends.
 *
 * Drives the SAME orchestrator path (AcpService.spawnSession) across the three
 * multi-account coding backends and proves, per backend:
 *   1. the requested backend identity round-trips    (SpawnResult.agentType)
 *   2. the selected account is stamped on the session (metadata.account, via
 *      accountMetaFromSessionMetadata — only when a pooled account exists)
 *   3. the per-backend MODEL env key is stamped       (OPENCODE_MODEL /
 *      ANTHROPIC_MODEL / OPENAI_MODEL — model is NOT a session.metadata field)
 *   4. the tiny app actually builds                   (proof file on disk)
 *   5. buildValidation passes on the produced dir     (scenario-runner #8945
 *      finalCheck, which really execs the command + checks exit 0)
 *
 *      [ matrix ]   opencode -> cerebras-api (gpt-oss-120b)
 *                   claude   -> anthropic-subscription
 *                   codex    -> openai-codex
 *
 * GATING (fail-green, per-backend):
 *   - DETERMINISTIC block ALWAYS runs (no auth, no quota, no network): the
 *     env-model-stamping proof (a fake recording acpx over the `cli` transport)
 *     and the buildValidation pass/skip primitives. So a totally bare box still
 *     exercises real code and exits 0.
 *   - LIVE spawns are opt-in via ELIZA_LIVE_CODING_MATRIX=1 AND gated per backend
 *     on local auth (codex ~/.codex/auth.json; claude ~/.claude/.credentials.json
 *     or macOS keychain or ANTHROPIC_API_KEY/CLAUDE_CODE_OAUTH_TOKEN; opencode
 *     CEREBRAS_API_KEY). A backend whose auth is absent records a skip and is not
 *     spawned. Live spawns spend real quota by design.
 *   - If every backend skips its live lane, one aggregate SKIP line is printed
 *     and the process exits 0 (CI green). A present-auth + opted-in backend that
 *     fails to build / mismatches account / fails buildValidation exits 1.
 *
 * This is a standalone script (not a .scenario.ts) because AcpService needs a
 * real subprocess transport the PGLite scenario runtime does not host; it reuses
 * the #8945 buildValidation finalCheck only for its own per-backend validation.
 *
 * Run:
 *   bun --conditions=eliza-source \
 *     plugins/plugin-agent-orchestrator/scripts/live-coding-backend-matrix-e2e.ts
 *   # add ELIZA_LIVE_CODING_MATRIX=1 (+ the relevant CLI logins / CEREBRAS_API_KEY)
 *   # to actually spawn the live backends.
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/agent/auth/account-storage";
import { getDefaultAccountPool } from "../../../packages/app-core/src/services/account-pool.ts";
import { runFinalCheck } from "../../../packages/scenario-runner/src/final-checks/index.ts";
import { AcpService } from "../src/services/acp-service.ts";
import {
  accountMetaFromSessionMetadata,
  getCodingAccountBridge,
  isMultiAccountAgentType,
} from "../src/services/coding-account-selection.ts";
import { TERMINAL_SESSION_STATUSES } from "../src/services/types.ts";

type MatrixAgentType = "opencode" | "claude" | "codex";

// ---------------------------------------------------------------------------
// Setup: hermetic state dir; cleaned up in finally.
// ---------------------------------------------------------------------------
const home = mkdtempSync(path.join(os.tmpdir(), "live-coding-matrix-"));
process.env.ELIZA_HOME = home;
process.env.ELIZA_STATE_DIR = home;
process.env.ELIZA_ACP_STATE_DIR = path.join(home, "acp");

const log = (m: string): void => console.log(m);
const LIVE = process.env.ELIZA_LIVE_CODING_MATRIX === "1";

const failures: string[] = [];
function assert(name: string, ok: boolean, detail?: string): void {
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  [${detail}]` : ""}`);
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
}

// ---------------------------------------------------------------------------
// The matrix. providerId is the account the bridge stamps for that backend;
// envKey is the per-backend model env var buildEnv() sets from opts.model.
// ---------------------------------------------------------------------------
interface BackendSpec {
  agentType: MatrixAgentType;
  providerId: string;
  model: string;
  envKey: "OPENCODE_MODEL" | "ANTHROPIC_MODEL" | "OPENAI_MODEL";
}

const MATRIX: BackendSpec[] = [
  {
    agentType: "opencode",
    providerId: "cerebras-api",
    model: "gpt-oss-120b",
    envKey: "OPENCODE_MODEL",
  },
  {
    agentType: "claude",
    providerId: "anthropic-subscription",
    model: "claude-sonnet-4-5",
    envKey: "ANTHROPIC_MODEL",
  },
  {
    agentType: "codex",
    providerId: "openai-codex",
    model: "gpt-5-codex",
    envKey: "OPENAI_MODEL",
  },
];

// ---------------------------------------------------------------------------
// Per-backend local-auth probes — mirror the real detection in the codebase.
// ---------------------------------------------------------------------------
function hasOpencodeAuth(): boolean {
  return Boolean(process.env.CEREBRAS_API_KEY?.trim());
}

/** Mirrors task-agent-frameworks.ts hasClaudeSubscriptionAuth() + env keys. */
function hasClaudeAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return true;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  if (existsSync(credPath)) return true;
  if (existsSync(path.join(os.homedir(), ".claude.json"))) return true;
  if (process.platform !== "darwin") return false;
  try {
    const raw = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return raw.length > 0;
  } catch {
    return false;
  }
}

/** Mirrors live-codex-spawn-e2e.ts: ~/.codex/auth.json with a ChatGPT login. */
function hasCodexAuth(): boolean {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  if (!existsSync(authPath)) return false;
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    return Boolean(auth?.tokens?.access_token && auth?.tokens?.account_id);
  } catch {
    return false;
  }
}

function backendAuthPresent(agentType: BackendSpec["agentType"]): boolean {
  if (agentType === "opencode") return hasOpencodeAuth();
  if (agentType === "claude") return hasClaudeAuth();
  return hasCodexAuth();
}

// ---------------------------------------------------------------------------
// runtime stub shared by all spawns.
// ---------------------------------------------------------------------------
function makeRuntime(
  settings: Record<string, string | undefined>,
): ConstructorParameters<typeof AcpService>[0] {
  return {
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(...a: unknown[]) {
        console.error("[acp]", ...a);
      },
    },
    getSetting: (k: string) => settings[k],
    services: new Map(),
  } as never;
}

// ---------------------------------------------------------------------------
// DETERMINISTIC pillar 1 — model env-key stamping (no auth, no quota).
//
// Uses a fake recording "acpx" over the `cli` transport. buildEnv() stamps the
// per-backend model env key from opts.model; the recorder writes the env it was
// spawned with to a JSONL proof file, which we then assert. This proves the
// model selection lands on the right env var WITHOUT a live model.
// ---------------------------------------------------------------------------
async function proveModelEnvStamping(): Promise<void> {
  log("\n=== DETERMINISTIC: per-backend model env-key stamping ===");
  const recHome = mkdtempSync(path.join(os.tmpdir(), "matrix-envproof-"));
  const proofFile = path.join(recHome, "env-proof.jsonl");
  process.env.ELIZA_MATRIX_PROOF_FILE = proofFile; // ELIZA_ prefix → forwarded
  const fakeCli = path.join(recHome, "fake-acpx.mjs");
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
const name = argv[argv.indexOf("--name") + 1] ?? "";
appendFileSync(process.env.ELIZA_MATRIX_PROOF_FILE, JSON.stringify({
  name,
  OPENCODE_MODEL: process.env.OPENCODE_MODEL ?? null,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL ?? null,
  OPENAI_MODEL: process.env.OPENAI_MODEL ?? null,
}) + "\\n");
process.exit(0);
`,
    { mode: 0o755 },
  );
  chmodSync(fakeCli, 0o755);

  const acp = new AcpService(
    makeRuntime({ ELIZA_ACP_TRANSPORT: "cli", ELIZA_ACP_CLI: fakeCli }),
  );
  await acp.start();
  const wd = path.join(recHome, "wd");
  try {
    for (const b of MATRIX) {
      await acp.spawnSession({
        agentType: b.agentType,
        workdir: wd,
        name: `env-${b.agentType}`,
        model: b.model,
      });
    }
    // The recorder exits 0 on `sessions new`; give the spawned procs a beat.
    await new Promise((r) => setTimeout(r, 800));
    const lines: Array<Record<string, unknown>> = existsSync(proofFile)
      ? readFileSync(proofFile, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    for (const b of MATRIX) {
      const rec = lines.find((l) => l.name === `env-${b.agentType}`);
      assert(
        `${b.agentType}: ${b.envKey} stamped from opts.model`,
        rec?.[b.envKey] === b.model,
        `${b.envKey}=${String(rec?.[b.envKey])}`,
      );
    }
  } finally {
    await acp.stop();
    delete process.env.ELIZA_MATRIX_PROOF_FILE;
    rmSync(recHome, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// DETERMINISTIC pillar 2 — buildValidation finalCheck primitives (#8945).
// Proves the clean-skip primitive (missing workdir) AND a real exec pass.
// ---------------------------------------------------------------------------
async function proveBuildValidationPrimitive(): Promise<void> {
  log("\n=== DETERMINISTIC: buildValidation finalCheck primitives ===");
  const checkCtx = {
    runtime: {} as never,
    ctx: { actionsCalled: [] } as never,
  };
  const realDir = mkdtempSync(path.join(os.tmpdir(), "matrix-bv-"));
  try {
    const pass = await runFinalCheck(
      {
        type: "buildValidation",
        name: "bv-pass",
        workdir: realDir,
        command: "echo BUILD_VALIDATED",
        expectExitZero: true,
      } as never,
      checkCtx,
    );
    assert(
      "buildValidation passes on an existing workdir",
      pass.status === "passed",
      pass.status,
    );

    const skip = await runFinalCheck(
      {
        type: "buildValidation",
        name: "bv-skip",
        workdir: path.join(os.tmpdir(), "matrix-no-such-dir-xyz-987"),
        command: "echo never",
        expectExitZero: true,
      } as never,
      checkCtx,
    );
    assert(
      "buildValidation self-skips on a missing workdir (clean-skip primitive)",
      skip.status === "skipped-dependency-missing",
      skip.status,
    );
  } finally {
    rmSync(realDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// LIVE pillar — per-backend spawn + build + account/model + buildValidation.
// Gated on opt-in + per-backend auth. Spends real quota by design.
// ---------------------------------------------------------------------------
type BackendOutcome = "passed" | "skipped" | "failed" | "blocked";

async function runLiveBackend(b: BackendSpec): Promise<BackendOutcome> {
  log(`\n=== LIVE: ${b.agentType} -> ${b.providerId} ===`);
  if (!backendAuthPresent(b.agentType)) {
    log(`SKIP ${b.agentType}: no local auth for ${b.providerId}`);
    return "skipped";
  }

  // If a CEREBRAS_API_KEY is present, register it as a pooled cerebras-api
  // account so the selector bridge can stamp metadata.account for opencode.
  if (b.agentType === "opencode" && process.env.CEREBRAS_API_KEY) {
    saveAccount({
      id: "matrix-cerebras",
      providerId: "cerebras-api",
      label: "Matrix Cerebras (live)",
      source: "api-key",
      credentials: {
        access: process.env.CEREBRAS_API_KEY,
        refresh: "",
        expires: Date.now() + 1e10,
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }
  // Install the selector bridge (no-op if no accounts are linked).
  getDefaultAccountPool();

  const wd = path.join(home, `wd-${b.agentType}`);
  mkdirSync(wd, { recursive: true });
  const proofPath = path.join(wd, "MATRIX_PROOF.txt");
  const marker = `${b.agentType}-matrix-live-ok`;

  const acp = new AcpService(
    makeRuntime({
      ELIZA_ACP_TRANSPORT: "native",
      ELIZA_CODING_ACCOUNT_STRATEGY: "least-used",
      ACPX_DEFAULT_TIMEOUT_MS: "180000",
    }),
  );
  await acp.start();
  const events: Array<{ event: string; data: unknown }> = [];
  acp.onSessionEvent((_sid, event, data) => events.push({ event, data }));

  try {
    log(`Spawning REAL ${b.agentType} sub-agent (may take 1-3 min)...`);
    const result = await acp.spawnSession({
      agentType: b.agentType,
      workdir: wd,
      name: `matrix-${b.agentType}`,
      model: b.model,
      initialTask:
        `Create a file named MATRIX_PROOF.txt in the current directory ` +
        `containing exactly the text: ${marker}. Then stop.`,
      metadata: { keepAliveAfterComplete: true },
      timeoutMs: 180_000,
    });

    // (1) requested backend identity round-trips — the only backend-identity
    //     field that actually lives on SpawnResult.
    assert(
      `${b.agentType}: SpawnResult.agentType === requested`,
      result.agentType === b.agentType,
      result.agentType,
    );

    // (2) account stamping — conditional-but-honest. Only assert a stamped
    //     account when this backend is multi-account, a bridge is installed,
    //     and selection produced one. Otherwise record single-account-fallback.
    const acct = accountMetaFromSessionMetadata(result.metadata);
    const bridgeInstalled = Boolean(getCodingAccountBridge());
    if (isMultiAccountAgentType(b.agentType) && bridgeInstalled && acct) {
      assert(
        `${b.agentType}: session.metadata.account.providerId === ${b.providerId}`,
        acct.providerId === b.providerId,
        `${acct.providerId}/${acct.accountId}`,
      );
    } else {
      log(
        `note ${b.agentType}: single-account-fallback (no stamped account: ` +
          `multiAccount=${isMultiAccountAgentType(b.agentType)} ` +
          `bridge=${bridgeInstalled} acct=${acct ? "yes" : "no"})`,
      );
    }

    // (3) poll for the built proof file or a terminal session event.
    const deadline = Date.now() + 200_000;
    while (Date.now() < deadline) {
      if (existsSync(proofPath)) break;
      if (
        events.some(
          (e) =>
            e.event === "task_complete" ||
            e.event === "error" ||
            TERMINAL_SESSION_STATUSES.has(e.event),
        )
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    const built = existsSync(proofPath);
    const errs = events
      .filter((e) => e.event === "error" || e.event === "login_required")
      .map((e) => JSON.stringify(e.data).slice(0, 300));
    log(`events: ${events.map((e) => e.event).join(", ") || "(none)"}`);

    // Honest rate-limit / auth handling — report blocked, not a hard fail.
    const blockedText = errs.join(" | ");
    const blocked =
      !built &&
      /rate.?limit|quota|usage|429|login_required|unauthor|invalid api key/i.test(
        blockedText,
      );
    if (blocked) {
      log(`BLOCKED ${b.agentType} (quota/auth): ${blockedText}`);
      return "blocked";
    }

    assert(
      `${b.agentType}: built MATRIX_PROOF.txt`,
      built,
      built ? readFileSync(proofPath, "utf-8").trim() : "(missing)",
    );
    if (!built) return "failed";

    // (4) buildValidation finalCheck on the produced dir (really execs).
    const bv = await runFinalCheck(
      {
        type: "buildValidation",
        name: `bv-${b.agentType}`,
        workdir: wd,
        command: "test -f MATRIX_PROOF.txt && echo BUILD_VALIDATED",
        expectExitZero: true,
      } as never,
      { runtime: {} as never, ctx: { actionsCalled: [] } as never },
    );
    assert(
      `${b.agentType}: buildValidation passed on produced dir`,
      bv.status === "passed",
      bv.status,
    );

    return failures.length ? "failed" : "passed";
  } finally {
    await acp.stop();
  }
}

// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // Deterministic pillars — always run, even on a totally bare box.
  await proveModelEnvStamping();
  await proveBuildValidationPrimitive();

  // Live pillar — opt-in + per-backend auth.
  const outcomes: Array<{ backend: string; outcome: BackendOutcome }> = [];
  if (!LIVE) {
    log(
      "\n=== LIVE matrix skipped: set ELIZA_LIVE_CODING_MATRIX=1 (+ backend logins) to spawn ===",
    );
    for (const b of MATRIX) {
      outcomes.push({ backend: b.agentType, outcome: "skipped" });
    }
  } else {
    for (const b of MATRIX) {
      try {
        outcomes.push({
          backend: b.agentType,
          outcome: await runLiveBackend(b),
        });
      } catch (e) {
        log(
          `ERROR ${b.agentType}: ${e instanceof Error ? e.message : String(e)}`,
        );
        outcomes.push({ backend: b.agentType, outcome: "failed" });
        failures.push(`${b.agentType}: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // Summary.
  log("\n=== MATRIX SUMMARY ===");
  for (const o of outcomes) log(`  ${o.backend}: ${o.outcome}`);
  const ranLive = outcomes.some((o) => o.outcome !== "skipped");
  if (!ranLive) {
    log(
      "SKIP (aggregate): no live coding backend was exercised " +
        "(no opt-in / no local auth). Deterministic pillars passed.",
    );
  }
  if (failures.length) {
    log(`\n${failures.length} assertion(s) FAILED:`);
    for (const f of failures) log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    log("\nAll executed assertions passed.");
    process.exitCode = 0;
  }
}

main()
  .catch((e) => {
    console.error("live coding matrix error:", e);
    process.exitCode = 1;
  })
  .finally(() => rmSync(home, { recursive: true, force: true }));
