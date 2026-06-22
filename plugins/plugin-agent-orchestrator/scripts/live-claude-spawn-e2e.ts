/**
 * LIVE Claude end-to-end — spawns a REAL Claude Code sub-agent via the
 * orchestrator's AcpService (the native ACP transport + claude-agent-acp
 * adapter) and asks it to build a trivial file, using the machine's local
 * Claude login (~/.claude.json) / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Parity with live-codex-spawn-e2e.ts. Proves live Claude coding through the
 * orchestrator end-to-end. Spends real Claude quota by design. Run:
 *   bun --conditions=eliza-source \
 *     plugins/plugin-agent-orchestrator/scripts/live-claude-spawn-e2e.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpService } from "../src/services/acp-service.ts";

const home = mkdtempSync(path.join(os.tmpdir(), "live-claude-e2e-"));
process.env.ELIZA_HOME = home;
process.env.ELIZA_STATE_DIR = home;
process.env.ELIZA_ACP_STATE_DIR = path.join(home, "acp");

const log = (m: string) => console.log(m);

function claudeAuthPresent(): boolean {
  if (process.env.ANTHROPIC_API_KEY?.trim()) return true;
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return true;
  return (
    existsSync(path.join(os.homedir(), ".claude", ".credentials.json")) ||
    existsSync(path.join(os.homedir(), ".claude.json"))
  );
}

async function main(): Promise<void> {
  if (!claudeAuthPresent()) {
    log(
      "SKIP: no Claude auth (~/.claude.json / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN)",
    );
    return;
  }

  const wd = path.join(home, "wd");
  const proofPath = path.join(wd, "LIVE_CLAUDE_PROOF.txt");
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
        ACPX_DEFAULT_TIMEOUT_MS: "180000",
      })[k],
    services: new Map(),
  } as never;

  const acp = new AcpService(runtime);
  await acp.start();
  const events: Array<{ event: string; data: unknown }> = [];
  acp.onSessionEvent((_sid, event, data) => events.push({ event, data }));

  log(
    "Spawning REAL Claude sub-agent (npx claude-agent-acp; may take a minute)...",
  );
  const result = await acp.spawnSession({
    agentType: "claude",
    workdir: wd,
    name: "live-claude",
    initialTask:
      "Create a file named LIVE_CLAUDE_PROOF.txt in the current directory containing exactly the text: claude-live-ok. Then stop.",
    metadata: { keepAliveAfterComplete: true },
    timeoutMs: 180_000,
  });
  log(`spawn result: session=${result.sessionId} status=${result.status}`);

  const deadline = Date.now() + 210_000;
  while (Date.now() < deadline) {
    if (existsSync(proofPath)) break;
    if (events.some((e) => e.event === "task_complete" || e.event === "error"))
      break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  const built = existsSync(proofPath);
  log("\n=== OUTCOME ===");
  log(`spawn status: ${result.status}`);
  log(
    `built LIVE_CLAUDE_PROOF.txt: ${
      built ? `YES — ${readFileSync(proofPath, "utf-8").trim()}` : "no"
    }`,
  );
  const errs = events
    .filter((e) => e.event === "error" || e.event === "login_required")
    .map((e) => JSON.stringify(e.data).slice(0, 300));
  if (errs.length) log(`agent errors: ${errs.join(" | ")}`);
  log(`events: ${events.map((e) => e.event).join(", ") || "(none)"}`);

  await acp.stop();
}

main()
  .catch((e) => {
    console.error("live claude e2e error:", e);
    process.exitCode = 1;
  })
  .finally(() => rmSync(home, { recursive: true, force: true }));
