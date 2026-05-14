#!/usr/bin/env bun
/**
 * run-orchestrator-opencode-cerebras — End-to-end smoke for the Eliza
 * agent-orchestrator path that spawns an `opencode` sub-agent and routes it
 * to Cerebras's gpt-oss-120b via the vendored opencode (with PR #26763's
 * reasoning-replay fix).
 *
 * What this script does:
 *   1. Boots a real AgentRuntime with plugin-coding-tools and
 *      plugin-agent-orchestrator (plus plugin-openai for ELiza's own message
 *      model, also pointed at Cerebras).
 *   2. Wires the env so `buildOpencodeSpawnConfig()` produces a Cerebras
 *      provider config and the orchestrator spawns opencode via PTY.
 *   3. Directly invokes the TASKS action with action=spawn_agent,
 *      agentType=opencode, and a coding task.
 *   4. Polls the PTYService for session completion and reports.
 *   5. Verifies the file was written in the spawn workdir.
 *
 * Expected env (set before invocation):
 *   CEREBRAS_API_KEY=csk-...                       (required)
 *   OPENCODE_BENCH_WORKDIR=/path/to/scratch        (optional; default: ./.orchestrator-bench)
 *   PATH must include bench-shim/ so `opencode` resolves to the vendored fork.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const RAW_KEY = process.env.CEREBRAS_API_KEY?.trim();
if (!RAW_KEY) {
  console.error("[orchestrator-smoke] CEREBRAS_API_KEY is required.");
  process.exit(1);
}
const CEREBRAS_API_KEY = RAW_KEY;

const CEREBRAS_BASE_URL =
  process.env.CEREBRAS_BASE_URL?.trim() ?? "https://api.cerebras.ai/v1";
const MODEL = process.env.CEREBRAS_MODEL?.trim() ?? "gpt-oss-120b";

const WORKDIR_ROOT = path.resolve(
  process.env.OPENCODE_BENCH_WORKDIR?.trim() ??
    path.join(REPO_ROOT, ".orchestrator-bench"),
);
const SESSION_TIMEOUT_MS = Number(
  process.env.OPENCODE_BENCH_SESSION_TIMEOUT_MS ?? 5 * 60 * 1000,
);

// ---------------------------------------------------------------------------
// Env wiring — must happen BEFORE we import the runtime / plugins, because
// readConfigEnvKey() and provider plumbing read these at module-load time.
// ---------------------------------------------------------------------------

process.env.OPENAI_BASE_URL = CEREBRAS_BASE_URL;
process.env.OPENAI_LARGE_MODEL = MODEL;
process.env.OPENAI_SMALL_MODEL = MODEL;
process.env.OPENAI_NANO_MODEL = MODEL;
process.env.ALLOW_NO_DATABASE = "true";

// agent-orchestrator: ELIZA_OPENCODE_LOCAL=1 + ELIZA_OPENCODE_BASE_URL pointed
// at cerebras triggers the patched cerebras branch in
// buildOpencodeSpawnConfig() that uses @ai-sdk/cerebras.
process.env.ELIZA_OPENCODE_LOCAL = "1";
process.env.ELIZA_OPENCODE_BASE_URL = CEREBRAS_BASE_URL;
process.env.ELIZA_OPENCODE_API_KEY = CEREBRAS_API_KEY;
process.env.ELIZA_OPENCODE_MODEL_POWERFUL = MODEL;

process.env.ELIZA_AGENT_ORCHESTRATOR = "1";

// Make sure the vendored opencode shim wins on PATH.
const SHIM = path.join(REPO_ROOT, "bench-shim");
if (!process.env.PATH?.includes(SHIM)) {
  process.env.PATH = `${SHIM}${path.delimiter}${process.env.PATH ?? ""}`;
}

await fs.mkdir(WORKDIR_ROOT, { recursive: true });

const TASK_LABEL = process.env.OPENCODE_BENCH_TASK_LABEL ?? "fizzbuzz";
const TASK_PROMPT =
  process.env.OPENCODE_BENCH_TASK_PROMPT ??
  "Write a Python file fizzbuzz.py (1..30, standard rules), then run `python fizzbuzz.py` and report the output. Keep it short.";

const sessionWorkdir = path.join(WORKDIR_ROOT, `session-${Date.now()}`);
await fs.mkdir(sessionWorkdir, { recursive: true });

// ---------------------------------------------------------------------------
// Now import the runtime + plugins.
// ---------------------------------------------------------------------------

import type { Action, Memory, UUID } from "@elizaos/core";
import { AgentRuntime, InMemoryDatabaseAdapter } from "@elizaos/core";

const { openaiPlugin } = await import("../plugins/plugin-openai/index.ts");
const codingToolsModule = await import(
  "../plugins/plugin-coding-tools/src/index.ts"
);
const orchestratorModule = await import(
  "../plugins/plugin-agent-orchestrator/src/index.ts"
);

const codingToolsPlugin =
  codingToolsModule.default ?? codingToolsModule.codingToolsPlugin;
const orchestratorPlugin =
  orchestratorModule.default ??
  (orchestratorModule as unknown as { agentOrchestratorPlugin?: unknown })
    .agentOrchestratorPlugin;

if (!codingToolsPlugin) {
  console.error("[orchestrator-smoke] failed to import plugin-coding-tools");
  process.exit(2);
}
if (!orchestratorPlugin) {
  console.error(
    "[orchestrator-smoke] failed to import plugin-agent-orchestrator",
  );
  process.exit(2);
}

const runtime = new AgentRuntime({
  character: {
    name: "OrchestratorOpenCodeSmoke",
    bio: ["Smoke runner that delegates coding tasks via opencode."],
    system:
      "You are an orchestrator. When asked to write code, delegate to a sub-agent via TASKS.spawn_agent with agentType=opencode.",
    templates: {},
    messageExamples: [],
    postExamples: [],
    topics: [],
    adjectives: [],
    knowledge: [],
    plugins: [],
    secrets: {
      CEREBRAS_API_KEY,
      OPENAI_BASE_URL: CEREBRAS_BASE_URL,
      ELIZA_OPENCODE_LOCAL: "1",
      ELIZA_OPENCODE_BASE_URL: CEREBRAS_BASE_URL,
      ELIZA_OPENCODE_API_KEY: CEREBRAS_API_KEY,
      ELIZA_OPENCODE_MODEL_POWERFUL: MODEL,
    },
  },
  adapter: new InMemoryDatabaseAdapter(),
  plugins: [openaiPlugin, codingToolsPlugin, orchestratorPlugin],
  settings: {
    CEREBRAS_API_KEY,
    OPENAI_BASE_URL: CEREBRAS_BASE_URL,
    OPENAI_LARGE_MODEL: MODEL,
    ALLOW_NO_DATABASE: "true",
    ELIZA_OPENCODE_LOCAL: "1",
    ELIZA_OPENCODE_BASE_URL: CEREBRAS_BASE_URL,
    ELIZA_OPENCODE_API_KEY: CEREBRAS_API_KEY,
    ELIZA_OPENCODE_MODEL_POWERFUL: MODEL,
  },
  logLevel: "info",
  disableBasicCapabilities: false,
});

await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
console.log(`[orchestrator-smoke] runtime ready (agentId=${runtime.agentId})`);

// Diagnostic: what services are registered?
try {
  const svcKeys = Array.from(
    (runtime as unknown as { services?: Map<string, unknown> }).services?.keys?.() ??
      [],
  );
  console.log("[diag] runtime.services keys:", svcKeys);
} catch (e) {
  console.log("[diag] could not enumerate services:", String(e));
}
console.log(
  "[diag] orchestrator plugin.services count:",
  Array.isArray(orchestratorPlugin.services)
    ? orchestratorPlugin.services.length
    : "n/a",
);
const ptySvc =
  (runtime.getService?.("PTY_SERVICE") as unknown) ??
  (runtime.getService?.("ACP_SERVICE") as unknown) ??
  null;
console.log("[diag] PTY_SERVICE present:", Boolean(ptySvc));

if (!ptySvc) {
  console.log("[diag] manually starting PTYService to surface error...");
  try {
    const startedPty = await (
      orchestratorModule as unknown as { PTYService: { start: typeof Function } }
    ).PTYService.start(runtime);
    console.log("[diag] manual PTYService.start succeeded:", Boolean(startedPty));
    const servicesMap = (runtime as unknown as { services?: Map<string, unknown[]> }).services;
    servicesMap?.set?.("PTY_SERVICE", [startedPty]);
  } catch (e) {
    console.log("[diag] manual PTYService.start threw:", e instanceof Error ? `${e.message}\n${e.stack}` : String(e));
  }
}

const actions = Array.isArray(runtime.actions)
  ? (runtime.actions as Action[])
  : [];
const tasksAction =
  actions.find((a) => a.name === "TASKS") ??
  actions.find((a) =>
    Array.isArray(a.similes) && a.similes.includes("SPAWN_AGENT"),
  );
if (!tasksAction) {
  console.error(
    "[orchestrator-smoke] TASKS action not found in runtime.actions. Loaded actions:",
    actions.map((a) => a.name),
  );
  process.exit(3);
}
console.log(`[orchestrator-smoke] TASKS action present: ${tasksAction.name}`);

// Synthesize a memory representing the user's coding-task request.
const roomId = crypto.randomUUID() as UUID;
const incoming: Memory = {
  id: crypto.randomUUID() as UUID,
  entityId: runtime.agentId,
  agentId: runtime.agentId,
  roomId,
  content: { text: `Spawn an opencode agent to: ${TASK_PROMPT}` },
  createdAt: Date.now(),
};

const callbackTexts: string[] = [];
const callback = async (content: { text?: string }) => {
  if (typeof content.text === "string" && content.text.trim().length > 0) {
    callbackTexts.push(content.text);
    console.log(`[callback] ${content.text}`);
  }
  return [];
};

console.log(
  `[orchestrator-smoke] spawning opencode in workdir: ${sessionWorkdir}`,
);
const spawnResult = (await tasksAction.handler(
  runtime,
  incoming,
  undefined,
  {
    parameters: {
      action: "spawn_agent",
      agentType: "opencode",
      task: TASK_PROMPT,
      workdir: sessionWorkdir,
      label: TASK_LABEL,
      approvalPreset: "yolo",
      keepAliveAfterComplete: false,
    },
  },
  callback,
)) as
  | {
      success?: boolean;
      text?: string;
      error?: string;
      data?: {
        agents?: Array<{
          sessionId?: string;
          workdir?: string;
          status?: string;
        }>;
      };
    }
  | undefined;

console.log("[orchestrator-smoke] spawn result:");
console.log(JSON.stringify(spawnResult, null, 2));

const sessionId = spawnResult?.data?.agents?.[0]?.sessionId;
if (!sessionId) {
  console.error("[orchestrator-smoke] no sessionId returned; aborting.");
  process.exit(4);
}
console.log(`[orchestrator-smoke] session id: ${sessionId}`);

// Poll the PTY service for completion.
const ptyServiceModule = await import(
  "../plugins/plugin-agent-orchestrator/src/services/pty-service.ts"
);
const coordinator = ptyServiceModule.getCoordinator
  ? ptyServiceModule.getCoordinator(runtime)
  : null;

const deadline = Date.now() + SESSION_TIMEOUT_MS;
let lastStatus = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  // Use the public listing/inspection API. Status fields evolve; just dump.
  let info: { status?: string } | undefined;
  if (coordinator?.getSession) {
    try {
      info = await coordinator.getSession(sessionId);
    } catch (e) {
      info = undefined;
    }
  }
  const status = info?.status ?? "(unknown)";
  if (status !== lastStatus) {
    console.log(`[orchestrator-smoke] status: ${status}`);
    lastStatus = status;
  }
  if (status === "completed" || status === "failed" || status === "stopped") {
    break;
  }
}

const files = await fs
  .readdir(sessionWorkdir, { withFileTypes: true })
  .catch(() => []);
console.log(
  `[orchestrator-smoke] files in ${sessionWorkdir}:`,
  files.map((f) => f.name),
);
const fizzbuzz = path.join(sessionWorkdir, "fizzbuzz.py");
const exists = await fs
  .stat(fizzbuzz)
  .then(() => true)
  .catch(() => false);
console.log(`[orchestrator-smoke] fizzbuzz.py exists: ${exists}`);
if (exists) {
  console.log(
    `[orchestrator-smoke] fizzbuzz.py contents:\n${await fs.readFile(fizzbuzz, "utf8")}`,
  );
}

console.log(
  `[orchestrator-smoke] ${exists ? "SUCCESS" : "FAILURE"} — task=${TASK_LABEL}`,
);
process.exit(exists ? 0 : 5);
