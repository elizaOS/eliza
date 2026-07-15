/**
 * LIVE Codex end-to-end — uses the machine's REAL ~/.codex ChatGPT login.
 *
 * Imports the real Codex credential as a pooled `openai-codex` account, probes
 * its REAL session usage, has the selector bridge pick it + materialize a
 * per-account CODEX_HOME, then spawns a REAL Codex sub-agent via the
 * orchestrator and asks it to build a trivial file. Verifies: real usage read,
 * real account selected, real credential injected, and (if quota allows) the
 * file actually built. Honestly reports a rate-limit outcome if the account is
 * at its session cap.
 *
 * Spends real Codex quota by design (the goal: "go and build something and
 * verify checking usage"). Run:
 *   bun --conditions=eliza-source \
 *     plugins/plugin-agent-orchestrator/scripts/live-codex-spawn-e2e.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/auth/account-storage";
import { getDefaultAccountPool } from "../../../packages/app-core/src/services/account-pool.ts";
import { getCodingAgentSelectorBridge } from "../../../packages/app-core/src/services/coding-account-bridge.ts";
import { AcpService } from "../src/services/acp-service.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "live-codex-e2e-"));
process.env.ELIZA_HOME = home;
process.env.ELIZA_STATE_DIR = home;
process.env.ELIZA_ACP_STATE_DIR = path.join(home, "acp");

const log = (m: string) => console.log(m);

function jwtExpMs(jwt: string): number {
  try {
    const p = jwt.split(".")[1] ?? "";
    const json = JSON.parse(
      Buffer.from(
        p + "=".repeat((4 - (p.length % 4)) % 4),
        "base64url",
      ).toString("utf-8"),
    );
    return typeof json.exp === "number"
      ? json.exp * 1000
      : Date.now() + 3600_000;
  } catch {
    return Date.now() + 3600_000;
  }
}

async function main() {
  const authPath = path.join(os.homedir(), ".codex", "auth.json");
  if (!existsSync(authPath)) {
    log("SKIP: no ~/.codex/auth.json (run `codex login` first)");
    return;
  }
  const auth = JSON.parse(readFileSync(authPath, "utf-8"));
  const access = auth?.tokens?.access_token as string | undefined;
  const refresh = (auth?.tokens?.refresh_token as string | undefined) ?? "";
  const idToken = auth?.tokens?.id_token as string | undefined;
  const accountId = auth?.tokens?.account_id as string | undefined;
  if (!access || !accountId) {
    log(
      "SKIP: ~/.codex/auth.json is not a ChatGPT login (no access_token/account_id)",
    );
    return;
  }

  saveAccount({
    id: "machine-codex",
    providerId: "openai-codex",
    label: "Machine Codex (live)",
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
  log(`Imported real Codex account (account_id ${accountId}).`);

  const pool = getDefaultAccountPool();
  const bridge = getCodingAgentSelectorBridge();
  if (!bridge) throw new Error("coding-account bridge not installed");

  // 1) LIVE usage probe through the pool.
  try {
    await pool.refreshUsage("machine-codex", access, {
      providerId: "openai-codex",
      codexAccountId: accountId,
    });
    const acct = pool
      .list("openai-codex")
      .find((a) => a.id === "machine-codex");
    log(
      `LIVE usage via pool: sessionPct=${acct?.usage?.sessionPct}% resetsAt=${acct?.usage?.resetsAt ? new Date(acct.usage.resetsAt).toISOString() : "n/a"}`,
    );
  } catch (e) {
    log(`usage refresh error: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) Bridge selects the real account + materializes a per-account CODEX_HOME
  //    populated from the real credential.
  const sel = await bridge.select("codex", { strategy: "least-used" });
  log(
    `bridge.select(codex) -> ${sel?.providerId}/${sel?.accountId}, CODEX_HOME=${sel?.envPatch.CODEX_HOME}`,
  );
  const codexHome = sel?.envPatch.CODEX_HOME;
  if (codexHome) {
    const materialized = JSON.parse(
      readFileSync(path.join(codexHome, "auth.json"), "utf-8"),
    );
    log(
      `materialized auth.json: auth_mode=${materialized.auth_mode} access_token matches real=${materialized.tokens?.access_token === access} account_id=${materialized.tokens?.account_id}`,
    );
  }

  // 3) Spawn a REAL Codex sub-agent and ask it to build a trivial file.
  const wd = path.join(home, "wd");
  const proofPath = path.join(wd, "LIVE_PROOF.txt");
  const runtime = {
    logger: {
      debug() {},
      info() {},
      warn() {},
      error(...a: unknown[]) {
        console.error("[acp]", ...a);
      },
    },
    getSetting: (k: string) =>
      ({
        ELIZA_ACP_TRANSPORT: "native",
        ELIZA_CODING_ACCOUNT_STRATEGY: "least-used",
        ACPX_DEFAULT_TIMEOUT_MS: "120000",
      })[k],
    services: new Map(),
  } as never;

  const acp = new AcpService(runtime);
  await acp.start();
  const events: Array<{ event: string; data: unknown }> = [];
  acp.onSessionEvent((_sid, event, data) => events.push({ event, data }));

  log(
    "Spawning REAL Codex sub-agent (npx @agentclientprotocol/codex-acp; may take a minute)...",
  );
  const result = await acp.spawnSession({
    agentType: "codex",
    workdir: wd,
    name: "live-codex",
    initialTask:
      "Create a file named LIVE_PROOF.txt in the current directory containing exactly the text: codex-live-ok. Then stop.",
    metadata: { keepAliveAfterComplete: true },
    timeoutMs: 120_000,
  });
  const acct = (result.metadata as Record<string, unknown>)?.account as
    | Record<string, unknown>
    | undefined;
  log(
    `spawn result: session=${result.sessionId} status=${result.status} account=${acct?.accountId}`,
  );

  // Wait up to ~150s for the agent to act.
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    if (existsSync(proofPath)) break;
    if (events.some((e) => e.event === "task_complete" || e.event === "error"))
      break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  const built = existsSync(proofPath);
  log(`\n=== OUTCOME ===`);
  log(
    `real account selected: ${acct?.providerId === "openai-codex" ? "YES" : "no"} (${acct?.accountId})`,
  );
  log(`real credential injected into CODEX_HOME: ${codexHome ? "YES" : "no"}`);
  log(
    `built LIVE_PROOF.txt: ${built ? `YES — ${readFileSync(proofPath, "utf-8").trim()}` : "no"}`,
  );
  const errs = events
    .filter((e) => e.event === "error")
    .map((e) => JSON.stringify(e.data).slice(0, 300));
  if (errs.length)
    log(
      `agent errors (expected if session usage is 100%): ${errs.join(" | ")}`,
    );
  log(`events: ${events.map((e) => e.event).join(", ") || "(none)"}`);

  await acp.stop();
}

main()
  .catch((e) => {
    console.error("live e2e error:", e);
    process.exitCode = 1;
  })
  .finally(() => rmSync(home, { recursive: true, force: true }));
