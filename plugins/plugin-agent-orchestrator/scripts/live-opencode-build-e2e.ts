/**
 * LIVE OpenCode end-to-end build — proves "go and build something + verify"
 * using the pooled Cerebras account (not rate-limited like the Codex one).
 *
 * Saves the machine's CEREBRAS_API_KEY as a pooled `cerebras-api` account, has
 * the selector bridge pick it for opencode (least-used), spawns a REAL opencode
 * sub-agent via the orchestrator, and asks it to BUILD a file. Verifies the
 * pooled account was selected, its key injected, and the file actually built.
 *
 *   bun --conditions=eliza-source \
 *     plugins/plugin-agent-orchestrator/scripts/live-opencode-build-e2e.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveAccount } from "@elizaos/agent/auth/account-storage";
import { getDefaultAccountPool } from "../../../packages/app-core/src/services/account-pool.ts";
import { getCodingAgentSelectorBridge } from "../../../packages/app-core/src/services/coding-account-bridge.ts";
import { AcpService } from "../src/services/acp-service.ts";

const cerebrasKey = process.env.CEREBRAS_API_KEY;
const home = mkdtempSync(path.join(os.tmpdir(), "live-opencode-e2e-"));
process.env.ELIZA_HOME = home;
process.env.ELIZA_STATE_DIR = home;
process.env.ELIZA_ACP_STATE_DIR = path.join(home, "acp");
const log = (m: string) => console.log(m);

async function main() {
  if (!cerebrasKey) {
    log("SKIP: no CEREBRAS_API_KEY in env");
    return;
  }
  saveAccount({
    id: "live-cerebras",
    providerId: "cerebras-api",
    label: "Machine Cerebras (live)",
    source: "api-key",
    credentials: {
      access: cerebrasKey,
      refresh: "",
      expires: Date.now() + 1e10,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  getDefaultAccountPool();
  const bridge = getCodingAgentSelectorBridge();
  if (!bridge) throw new Error("coding-account bridge not installed");
  const sel = await bridge.select("opencode", { strategy: "least-used" });
  log(
    `bridge.select(opencode) -> ${sel?.providerId}/${sel?.accountId}; injects ${Object.keys(sel?.envPatch ?? {}).join(",")}`,
  );

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
      (
        ({
          ELIZA_ACP_TRANSPORT: "native",
          ELIZA_CODING_ACCOUNT_STRATEGY: "least-used",
          ACPX_DEFAULT_TIMEOUT_MS: "150000",
        }) as Record<string, string>
      )[k],
    services: new Map(),
  } as never;
  const acp = new AcpService(runtime);
  await acp.start();
  const events: Array<{ event: string; data: unknown }> = [];
  acp.onSessionEvent((_s, event, data) => events.push({ event, data }));

  log("Spawning REAL opencode sub-agent (Cerebras)...");
  const result = await acp.spawnSession({
    agentType: "opencode",
    workdir: wd,
    name: "live-opencode",
    initialTask:
      "Create a file named LIVE_PROOF.txt in the current directory containing exactly: opencode-cerebras-live-ok. Then stop.",
    metadata: { keepAliveAfterComplete: true },
    timeoutMs: 150_000,
  });
  const acct = (result.metadata as Record<string, unknown>)?.account as
    | Record<string, unknown>
    | undefined;
  log(
    `spawn: session=${result.sessionId} status=${result.status} account=${acct?.providerId}/${acct?.accountId}`,
  );

  const deadline = Date.now() + 170_000;
  while (Date.now() < deadline) {
    if (existsSync(proofPath)) break;
    if (events.some((e) => e.event === "task_complete" || e.event === "error"))
      break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const built = existsSync(proofPath);
  log(`\n=== OUTCOME ===`);
  log(
    `pooled account selected: ${acct?.providerId === "cerebras-api" ? "YES" : "no"} (${acct?.accountId})`,
  );
  log(
    `CEREBRAS_API_KEY injected from pool: ${sel?.envPatch.CEREBRAS_API_KEY === cerebrasKey ? "YES" : "no"}`,
  );
  log(
    `BUILT LIVE_PROOF.txt: ${built ? "YES — " + readFileSync(proofPath, "utf-8").trim() : "no"}`,
  );
  const errs = events
    .filter((e) => e.event === "error")
    .map((e) => JSON.stringify(e.data).slice(0, 240));
  if (errs.length) log(`errors: ${errs.join(" | ")}`);
  log(`events: ${events.map((e) => e.event).join(", ") || "(none)"}`);
  await acp.stop();
}
main()
  .catch((e) => {
    console.error("live opencode e2e error:", e);
    process.exitCode = 1;
  })
  .finally(() => rmSync(home, { recursive: true, force: true }));
