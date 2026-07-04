#!/usr/bin/env bun
/**
 * LIVE multi-account orchestrator e2e (#9960) — the real-account counterpart to
 * the secret-free `compose-multi-account-e2e.ts` (which uses a fake `acpx`).
 *
 * Seeds the account pool from CI/operator-provided real credentials — ≥1 (ideally
 * 2) Claude `anthropic-subscription` OAuth tokens and ≥1 (ideally 2) Codex
 * `openai-codex` `auth.json` blobs — then drives the REAL coding-account bridge
 * to prove, per provider:
 *   - the bridge selects a healthy account and injects its credential into the
 *     spawn env (Claude → CLAUDE_CODE_OAUTH_TOKEN, Codex → per-account CODEX_HOME
 *     with a materialized auth.json),
 *   - consecutive selections ROTATE across DISTINCT accounts when ≥2 are present.
 *
 * Gated by ORCHESTRATOR_LIVE_MULTI_ACCOUNT=1 AND the presence of the credential
 * env vars. With neither configured it SKIPS CLEANLY (exit 0 + ::notice::) so it
 * never fails CI when the live secrets are absent — the scheduled lane relies on
 * this. The proof is selection + credential injection + distinct-account
 * rotation (no real spawn, so it does not burn task quota).
 *
 * Credential env vars (JSON or raw token; 1..N indexed):
 *   ELIZA_LIVE_CLAUDE_OAUTH_TOKEN_1 .. _N   raw Claude Code OAuth token
 *   ELIZA_LIVE_CODEX_AUTH_JSON_1    .. _N    full ~/.codex/auth.json contents
 *
 * Run:
 *   ORCHESTRATOR_LIVE_MULTI_ACCOUNT=1 bun \
 *     plugins/plugin-agent-orchestrator/scripts/live-multi-account-e2e.ts
 */

import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// Pure readiness assessor — no app-core graph, safe to import before the gate.
import { assessCodingAccountReadiness } from "../src/services/coding-account-selection.js";

// The runtime deps (account storage + coding-account bridge) pull in the full
// app-core/core graph. They are dynamically imported AFTER the gate so the
// clean-skip path never loads them — the scheduled lane invokes this with no
// secrets and must exit 0 without touching the build graph.
type SaveAccount = typeof import("@elizaos/auth/account-storage").saveAccount;
type GetBridge =
  typeof import("../../../packages/app-core/src/services/coding-account-bridge.ts").getCodingAgentSelectorBridge;
let saveAccount: SaveAccount;
let getCodingAgentSelectorBridge: GetBridge;

const log = (m: string) => console.log(`[live-multi-account] ${m}`);
const notice = (m: string) => console.log(`::notice::${m}`);

function gatedOff(reason: string): never {
  notice(`live multi-account e2e skipped — ${reason}`);
  process.exit(0);
}

function jwtExpMs(jwt: string): number {
  try {
    const p = jwt.split(".")[1] ?? "";
    const json = JSON.parse(
      Buffer.from(
        p + "=".repeat((4 - (p.length % 4)) % 4),
        "base64url",
      ).toString("utf-8"),
    );
    return typeof json.exp === "number" ? json.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

/** Collect ELIZA_LIVE_<base>_1.._N env values (stops at the first gap). */
function collectIndexed(base: string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 16; i++) {
    const v = process.env[`${base}_${i}`]?.trim();
    if (v) out.push(v);
  }
  return out;
}

function seedClaude(tokens: string[]): string[] {
  const ids: string[] = [];
  tokens.forEach((token, idx) => {
    const id = `live-claude-${idx + 1}`;
    saveAccount({
      id,
      providerId: "anthropic-subscription",
      label: `Live Claude ${idx + 1}`,
      source: "oauth",
      credentials: { access: token, refresh: "", expires: jwtExpMs(token) },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    ids.push(id);
  });
  return ids;
}

function seedCodex(blobs: string[]): string[] {
  const ids: string[] = [];
  blobs.forEach((blob, idx) => {
    const auth = JSON.parse(blob);
    const access = auth?.tokens?.access_token as string | undefined;
    const refresh = (auth?.tokens?.refresh_token as string | undefined) ?? "";
    const idToken = auth?.tokens?.id_token as string | undefined;
    const accountId = auth?.tokens?.account_id as string | undefined;
    if (!access || !accountId) {
      log(
        `SKIP codex blob ${idx + 1}: not a ChatGPT login (no access/account_id)`,
      );
      return;
    }
    const id = `live-codex-${idx + 1}`;
    saveAccount({
      id,
      providerId: "openai-codex",
      label: `Live Codex ${idx + 1}`,
      source: "oauth",
      credentials: {
        access,
        refresh,
        expires: jwtExpMs(access),
        ...(idToken ? { idToken } : {}),
      },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      organizationId: accountId,
    });
    ids.push(id);
  });
  return ids;
}

async function assertRotation(
  agentType: "claude" | "codex",
  expectedEnvKey: string,
  seededIds: string[],
): Promise<void> {
  const bridge = getCodingAgentSelectorBridge();
  if (!bridge) throw new Error("coding-account bridge not installed");

  // Two consecutive selections under least-used must rotate across distinct
  // accounts when ≥2 are seeded; with 1 account both pick it (no rotation).
  const first = await bridge.select(agentType, { strategy: "least-used" });
  if (!first) throw new Error(`${agentType}: bridge selected no account`);
  if (!first.envPatch[expectedEnvKey]) {
    throw new Error(`${agentType}: env patch missing ${expectedEnvKey}`);
  }
  log(`${agentType} #1 -> ${first.accountId} (${expectedEnvKey} injected)`);

  const second = await bridge.select(agentType, {
    strategy: "least-used",
    exclude: [first.accountId],
  });
  if (seededIds.length >= 2) {
    if (!second || second.accountId === first.accountId) {
      throw new Error(
        `${agentType}: expected a DISTINCT 2nd account, got ${second?.accountId ?? "none"}`,
      );
    }
    log(`${agentType} #2 -> ${second.accountId} (distinct ✓)`);
  } else {
    log(`${agentType}: only 1 account seeded — rotation not asserted`);
  }
}

async function main(): Promise<void> {
  if (process.env.ORCHESTRATOR_LIVE_MULTI_ACCOUNT !== "1") {
    gatedOff("ORCHESTRATOR_LIVE_MULTI_ACCOUNT is not 1");
  }
  const claudeTokens = collectIndexed("ELIZA_LIVE_CLAUDE_OAUTH_TOKEN");
  const codexBlobs = collectIndexed("ELIZA_LIVE_CODEX_AUTH_JSON");
  if (claudeTokens.length === 0 || codexBlobs.length === 0) {
    gatedOff(
      `need ≥1 Claude token AND ≥1 Codex auth blob (have claude=${claudeTokens.length} codex=${codexBlobs.length})`,
    );
  }

  const home = mkdtempSync(path.join(os.tmpdir(), "live-multi-account-"));
  process.env.ELIZA_HOME = home;
  process.env.ELIZA_STATE_DIR = home;
  process.env.ELIZA_ACP_STATE_DIR = path.join(home, "acp");
  process.env.ELIZA_CODING_ACCOUNT_STRATEGY ??= "least-used";

  // Gate passed and credentials present — now load the runtime graph.
  ({ saveAccount } = await import("@elizaos/auth/account-storage"));
  ({ getCodingAgentSelectorBridge } = await import(
    "../../../packages/app-core/src/services/coding-account-bridge.ts"
  ));

  const claudeIds = seedClaude(claudeTokens);
  const codexIds = seedCodex(codexBlobs);
  log(
    `seeded ${claudeIds.length} Claude + ${codexIds.length} Codex account(s)`,
  );
  if (claudeIds.length === 0 || codexIds.length === 0) {
    throw new Error("seeding produced no usable account for one provider");
  }

  await assertRotation("claude", "CLAUDE_CODE_OAUTH_TOKEN", claudeIds);
  await assertRotation("codex", "CODEX_HOME", codexIds);

  // Loud readiness gate (#9960): the seeded pool must actually be ready for live
  // coding work — ≥1 healthy Claude AND ≥1 healthy Codex, and ≥2 each (rotation
  // posture) when ≥2 of each were seeded. A thin/unhealthy pool fails HERE
  // instead of silently degrading to single-account at spawn time.
  const wantRotation = claudeIds.length >= 2 && codexIds.length >= 2;
  const readiness = assessCodingAccountReadiness(
    getCodingAgentSelectorBridge()?.describe() ?? {},
    { rotation: wantRotation },
  );
  if (!readiness.ready) {
    throw new Error(
      `account-readiness gate failed (rotation=${wantRotation}): ${readiness.problems.join("; ")}`,
    );
  }
  log(
    `readiness OK (rotation=${wantRotation}) — ${readiness.providers
      .map((p) => `${p.agentType}:${p.healthy}/${p.required}`)
      .join(" ")}`,
  );

  // Materialization check: Codex selection writes a per-account auth.json.
  const bridge = getCodingAgentSelectorBridge();
  const codexSel = await bridge?.select("codex", { strategy: "least-used" });
  const codexHome = codexSel?.envPatch.CODEX_HOME;
  if (codexHome) {
    const materialized = JSON.parse(
      readFileSync(path.join(codexHome, "auth.json"), "utf-8"),
    );
    if (materialized?.auth_mode !== "chatgpt") {
      throw new Error("materialized Codex auth.json is not chatgpt-mode");
    }
    log(`Codex CODEX_HOME materialized auth.json (auth_mode=chatgpt ✓)`);
  }

  log("PASS — real Claude + Codex accounts selected, injected, and rotated");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(
      `[live-multi-account] FAIL: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  },
);
