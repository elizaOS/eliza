/**
 * Offline composed end-to-end check for multi-account coding-agent selection.
 *
 * Proves the WHOLE pipeline through real code, no server / no live OAuth:
 *   real app-core AccountPool (reading real-format credential files in a temp
 *   state dir) → installed globalThis selector bridge → orchestrator
 *   AcpService.spawnSession → a REAL spawned subprocess that receives the
 *   injected per-account credential and records it.
 *
 * The only stand-in is the coding-agent binary itself (a tiny fake "acpx" that
 * logs its injected env and exits 0) — exactly the piece your real Claude/Codex
 * subscription CLI provides. Point ELIZA_ACP_CLI at the real binary + connect
 * real accounts to run the same flow for true live-key validation.
 *
 * Run:  bun --conditions=eliza-source \
 *         plugins/plugin-agent-orchestrator/scripts/compose-multi-account-e2e.ts
 */
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/auth/account-storage";
// Import the pool from app-core SRC, not the package barrel: app-core has no
// `eliza-source` export condition, so the barrel resolves to (possibly stale)
// dist — which may predate the coding-agent selector bridge. The src path
// guarantees we install the bridge under test.
import { getDefaultAccountPool } from "../../../packages/app-core/src/services/account-pool.ts";
import { AcpService } from "../src/services/acp-service.ts";

const FAR_FUTURE = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
const home = mkdtempSync(path.join(tmpdir(), "ma-compose-e2e-"));
process.env.ELIZA_HOME = home;
process.env.ELIZA_STATE_DIR = home;
process.env.ELIZA_ACP_STATE_DIR = path.join(home, "acp");
// Parent creds that MUST be dropped so the selected account authenticates.
process.env.ANTHROPIC_API_KEY = "sk-ant-api-PARENT-must-drop";
process.env.OPENAI_API_KEY = "sk-openai-PARENT-must-drop";

const proofFile = path.join(home, "agent-proof.jsonl");
process.env.ELIZA_MA_PROOF_FILE = proofFile; // ELIZA_ prefix → forwarded to child

// Fake "acpx": records the credentials injected into its env, then exits 0 so
// the session reaches `ready`. (Selection + injection happen on `sessions new`.)
const fakeCli = path.join(home, "fake-acpx.mjs");
writeFileSync(
  fakeCli,
  `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.ELIZA_MA_PROOF_FILE, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  CODEX_HOME: process.env.CODEX_HOME ?? null,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,
}) + "\\n");
process.exit(0);
`,
  { mode: 0o755 },
);
chmodSync(fakeCli, 0o755);

function mkAccount(
  providerId: "anthropic-subscription" | "openai-codex",
  id: string,
  access: string,
  organizationId?: string,
) {
  saveAccount({
    id,
    providerId,
    label: id,
    source: "oauth",
    credentials: { access, refresh: `${access}-r`, expires: FAR_FUTURE },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...(organizationId ? { organizationId } : {}),
  });
}

const checks: Array<{ name: string; ok: boolean; detail?: string }> = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, ...(detail ? { detail } : {}) });
}

function runtime() {
  return {
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(...a: unknown[]) {
        console.error("[acp]", ...a);
      },
    },
    getSetting: (key: string) =>
      ({
        ELIZA_ACP_TRANSPORT: "cli",
        ELIZA_ACP_CLI: fakeCli,
        ELIZA_CODING_ACCOUNT_STRATEGY: "least-used",
      })[key],
    services: new Map(),
  } as never;
}

function readProof(): Array<Record<string, unknown>> {
  try {
    return readFileSync(proofFile, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

async function main() {
  mkAccount("anthropic-subscription", "claude-A", "oat-AAA");
  mkAccount("anthropic-subscription", "claude-B", "oat-BBB");
  mkAccount("openai-codex", "codex-A", "codex-tok", "org_codexA");

  getDefaultAccountPool(); // installs the globalThis coding-agent selector bridge

  const acp = new AcpService(runtime());
  await acp.start();
  const wd = path.join(home, "wd");

  // Two consecutive Claude spawns must land on DISTINCT accounts (least-used).
  const s1 = await acp.spawnSession({
    agentType: "claude",
    workdir: wd,
    name: "c1",
  });
  const s2 = await acp.spawnSession({
    agentType: "claude",
    workdir: wd,
    name: "c2",
  });
  const a1 = (s1.metadata as Record<string, unknown>)?.account as
    | Record<string, unknown>
    | undefined;
  const a2 = (s2.metadata as Record<string, unknown>)?.account as
    | Record<string, unknown>
    | undefined;
  check(
    "claude spawn 1 selected an account",
    Boolean(a1?.accountId),
    String(a1?.accountId),
  );
  check(
    "claude spawn 2 selected an account",
    Boolean(a2?.accountId),
    String(a2?.accountId),
  );
  check(
    "two claude spawns used DISTINCT accounts (round-robin least-used)",
    Boolean(a1?.accountId) && a1?.accountId !== a2?.accountId,
    `${a1?.accountId} vs ${a2?.accountId}`,
  );

  // Follow-up prompts use the cli transport's fresh subprocess path. It must
  // re-resolve credentials for the SAME selected session/account rather than
  // drifting to a different least-used account.
  await acp.sendToSession(s1.sessionId, "follow-up prompt for c1");

  // One Codex spawn → per-account CODEX_HOME materialized.
  const s3 = await acp.spawnSession({
    agentType: "codex",
    workdir: wd,
    name: "x1",
  });
  const a3 = (s3.metadata as Record<string, unknown>)?.account as
    | Record<string, unknown>
    | undefined;
  check(
    "codex spawn selected the codex account",
    a3?.providerId === "openai-codex",
    String(a3?.accountId),
  );

  const proof = readProof();
  const claudeLines = proof.filter(
    (p) => typeof p.CLAUDE_CODE_OAUTH_TOKEN === "string",
  );
  const codexLines = proof.filter((p) => typeof p.CODEX_HOME === "string");
  const claudeTokens = new Set(
    claudeLines.map((p) => p.CLAUDE_CODE_OAUTH_TOKEN),
  );
  const argv = (p: Record<string, unknown>): string[] =>
    Array.isArray(p.argv) ? p.argv.map(String) : [];
  const hasArgs = (p: Record<string, unknown>, needles: string[]): boolean => {
    const args = argv(p);
    return needles.every((needle) => args.includes(needle));
  };
  const c1Spawn = claudeLines.find((p) =>
    hasArgs(p, ["claude", "sessions", "new", "--name", "c1"]),
  );
  const c1FollowUp = claudeLines.find((p) =>
    hasArgs(p, ["claude", "prompt", "-s", "c1"]),
  );

  check(
    "real subprocess received an injected Claude OAuth token",
    claudeLines.length >= 3,
    `${claudeLines.length} claude invocations`,
  );
  check(
    "the two Claude subprocesses got DISTINCT injected tokens",
    claudeTokens.size >= 2,
    [...claudeTokens].join(", "),
  );
  check(
    "parent ANTHROPIC_API_KEY was DROPPED from claude subprocess env",
    claudeLines.every((p) => p.ANTHROPIC_API_KEY === null),
  );
  check(
    "Claude follow-up subprocess reused spawn 1's selected account token",
    Boolean(c1Spawn?.CLAUDE_CODE_OAUTH_TOKEN) &&
      c1Spawn?.CLAUDE_CODE_OAUTH_TOKEN === c1FollowUp?.CLAUDE_CODE_OAUTH_TOKEN,
    `${String(c1Spawn?.CLAUDE_CODE_OAUTH_TOKEN)} -> ${String(
      c1FollowUp?.CLAUDE_CODE_OAUTH_TOKEN,
    )}`,
  );
  check(
    "codex subprocess received a per-account CODEX_HOME",
    codexLines.length >= 1 &&
      String(codexLines[0]?.CODEX_HOME).includes("_codex-home"),
    String(codexLines[0]?.CODEX_HOME),
  );
  check(
    "parent OPENAI_API_KEY was DROPPED from codex subprocess env",
    codexLines.every((p) => p.OPENAI_API_KEY === null),
  );
  // The materialized auth.json carries the selected account's token + account_id.
  const codexHome = String(codexLines[0]?.CODEX_HOME ?? "");
  let authOk = false;
  try {
    const authJson = JSON.parse(
      readFileSync(path.join(codexHome, "auth.json"), "utf-8"),
    );
    authOk =
      authJson.auth_mode === "chatgpt" &&
      authJson.tokens?.access_token === "codex-tok" &&
      authJson.tokens?.account_id === "org_codexA";
  } catch {
    authOk = false;
  }
  check(
    "codex auth.json has the selected account's token + account_id",
    authOk,
  );

  await acp.stop();
}

main()
  .then(() => {
    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) {
      console.log(
        `${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`,
      );
    }
    console.log(
      `\n${checks.length - failed.length}/${checks.length} checks passed`,
    );
    rmSync(home, { recursive: true, force: true });
    process.exit(failed.length === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error("E2E harness error:", err);
    rmSync(home, { recursive: true, force: true });
    process.exit(2);
  });
