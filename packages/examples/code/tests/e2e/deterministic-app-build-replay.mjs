#!/usr/bin/env bun
/**
 * DETERMINISTIC end-to-end app build with the REAL eliza-code coding agent and
 * NO live LLM.
 *
 * The orchestrator's real AcpService spawns the real eliza-code ACP agent
 * (src/acp.ts, codingOnly) — the same agent the live bot uses. Its OpenAI-
 * compatible provider is pointed at the local record/replay proxy
 * (llm-record-replay-proxy.mjs). In REPLAY (default) it serves a recorded
 * recorded qwen/qwen3.8-27b session (fixtures/random-color-session.json), so the
 * whole orchestrator → real-agent → plan/tool/file-write → task_complete
 * pipeline runs deterministically with the model mocked at the PROVIDER level
 * (not the agent) — keyless, no live LLM.
 *
 * Record a fresh fixture from THIS driver's exact context (so replay never
 * diverges), against an OpenAI-compatible endpoint:
 *   LLM_MODE=record LLM_KEY=... LLM_UPSTREAM=https://api.cerebras.ai/v1 \
 *     LLM_MODEL=gemma-4-31b bun --conditions eliza-source \
 *     --tsconfig-override ../../../tsconfig.json tests/e2e/deterministic-app-build-replay.mjs
 *
 * Replay (default, keyless, CI):
 *   bun --conditions eliza-source --tsconfig-override ../../../tsconfig.json \
 *     tests/e2e/deterministic-app-build-replay.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AcpService } from "../../../../../plugins/plugin-agent-orchestrator/src/services/acp-service.js";
import { waitForAdvertisedPort } from "../../../../scripts/e2e-ports.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../../..");
const proxy = join(here, "llm-record-replay-proxy.mjs");
const fixture = join(here, "fixtures", "random-color-session.json");
const acpEntry = resolve(here, "..", "..", "src", "acp.ts");
const MODE = process.env.LLM_MODE === "record" ? "record" : "replay";
const KEY = process.env.CEREBRAS_API_KEY || process.env.LLM_KEY || "";
const UPSTREAM = process.env.LLM_UPSTREAM || "https://api.cerebras.ai/v1";
const MODEL = process.env.LLM_MODEL || "qwen/qwen3.8-27b";
// FIXED workdir (reset clean each run) — record and replay MUST share the same
// filesystem context, or the agent's tool results diverge and replay drifts off
// the recorded turn sequence. Path is normalized out of the match key anyway.
const workdir = join(realpathSync(tmpdir()), "eliza-det-replay-workspace");

// The EXACT prompt the session is recorded with — must match for replay keys.
const PROMPT =
  "Build a minimal random-color web app. Create index.html with a button; " +
  "when clicked it sets document.body.style.background to a random hex color " +
  "(inline <script> is fine). Keep it to one file. Then stop.";

if (MODE === "record" && !KEY) {
  console.error("LLM_MODE=record needs LLM_KEY or CEREBRAS_API_KEY");
  process.exit(2);
}

// Kernel-assigned per run: the proxy binds port 0 and advertises the bound
// port through this file, so concurrent CI jobs cannot collide and there is
// no probe-then-release window (#18359).
const proxyPortFile = join(
  realpathSync(tmpdir()),
  `eliza-det-replay-port-${process.pid}`,
);
const proxyProc = spawn("node", [proxy], {
  env: {
    ...process.env,
    MODE,
    LLM_RECORDING: fixture,
    LLM_REPLAY_WORKDIR: workdir,
    PORT: "0",
    LLM_PROXY_PORT_FILE: proxyPortFile,
    ...(MODE === "record" ? { LLM_UPSTREAM: UPSTREAM, LLM_KEY: KEY } : {}),
  },
  stdio: ["ignore", "ignore", "inherit"],
});
const PORT = await waitForAdvertisedPort(proxyPortFile, { child: proxyProc });
rmSync(proxyPortFile, { force: true });

rmSync(workdir, { recursive: true, force: true });
mkdirSync(workdir, { recursive: true });
execFileSync("git", ["init", "-q"], { cwd: workdir });
execFileSync("git", ["config", "user.email", "e2e@test.local"], {
  cwd: workdir,
});
execFileSync("git", ["config", "user.name", "e2e"], { cwd: workdir });

const acpCommand = `bun --conditions eliza-source --tsconfig-override ${join(repoRoot, "tsconfig.json")} ${acpEntry}`;
const runtime = {
  agentId: "det-replay-e2e",
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  getSetting: (k) => {
    if (k === "ELIZA_ACP_TRANSPORT") return "native";
    if (k === "ELIZA_ACP_DEFAULT_AGENT") return "elizaos";
    if (k === "ELIZA_ELIZAOS_ACP_COMMAND") return acpCommand;
    return process.env[k];
  },
};

const service = new AcpService(runtime);
const pglite = mkdtempSync(join(tmpdir(), "det-pglite-"));
let sessionId;
let ok = false;
try {
  await service.start();
  const spawned = await service.spawnSession({
    agentType: "elizaos",
    workdir,
    approvalPreset: "permissive",
    timeoutMs: 240_000,
    env: {
      ELIZA_CODE_PROVIDER: "openai",
      OPENAI_API_KEY:
        MODE === "record" ? KEY : "no-live-llm-deterministic-replay",
      OPENAI_BASE_URL: `http://127.0.0.1:${PORT}/v1`,
      OPENAI_LARGE_MODEL: MODEL,
      OPENAI_SMALL_MODEL: MODEL,
      SECRET_SALT: "det-replay-e2e",
      ELIZA_ALLOW_DEFAULT_SECRET_SALT: "1",
      PGLITE_DATA_DIR: pglite,
    },
  });
  sessionId = spawned.sessionId;
  const result = await service.sendPrompt(sessionId, PROMPT, {
    timeoutMs: 240_000,
  });
  await fetch(`http://127.0.0.1:${PORT}/__complete`, { method: "POST" });
  const built = existsSync(join(workdir, "index.html"));
  console.log(
    `[${MODE}] stopReason:`,
    result.stopReason,
    "| index.html built:",
    built,
  );
  if (built) {
    const html = readFileSync(join(workdir, "index.html"), "utf8");
    const sane = /<button/i.test(html) && /random/i.test(html);
    console.log("index.html sane:", sane, `(${html.split("\n").length} lines)`);
    ok = sane && result.stopReason === "end_turn";
  }
  console.log(
    ok
      ? `\n✓ DETERMINISTIC real-agent app build PASS (${MODE}${MODE === "replay" ? " — no live LLM" : ""})`
      : "\n✗ FAIL",
  );
} finally {
  if (sessionId) {
    try {
      await service.closeSession(sessionId);
    } catch (error) {
      // error-policy:J6 the service stop below owns final process cleanup.
      console.warn(`Failed to close replay session: ${String(error)}`);
    }
  }
  try {
    await service.stop();
  } catch (error) {
    // error-policy:J6 the driver is already at its outer teardown boundary.
    console.warn(`Failed to stop replay service: ${String(error)}`);
  }
  proxyProc.kill();
  rmSync(workdir, { recursive: true, force: true });
  rmSync(pglite, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
