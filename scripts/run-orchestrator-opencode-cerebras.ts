#!/usr/bin/env bun
/**
 * ACP smoke for plugin-agent-orchestrator -> OpenCode -> Cerebras.
 *
 * Dry run:
 *   OPENCODE_CEREBRAS_DRY_RUN=1 bun scripts/run-orchestrator-opencode-cerebras.ts
 *
 * Live run:
 *   CEREBRAS_API_KEY=csk-... bun scripts/run-orchestrator-opencode-cerebras.ts
 *
 * The script uses AcpService directly, which is the only supported
 * plugin-agent-orchestrator task-agent transport.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IAgentRuntime } from "@elizaos/core";
import { AcpService } from "../plugins/plugin-agent-orchestrator/src/services/acp-service.ts";
import {
  buildOpencodeAcpEnv,
  buildOpencodeSpawnConfig,
  resolveVendoredOpencodeShim,
} from "../plugins/plugin-agent-orchestrator/src/services/opencode-config.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const DRY_RUN = process.env.OPENCODE_CEREBRAS_DRY_RUN === "1";
const RAW_KEY =
  process.env.CEREBRAS_API_KEY?.trim() ||
  process.env.ELIZA_E2E_CEREBRAS_API_KEY?.trim() ||
  (DRY_RUN ? "csk_dry_run" : "");

if (!RAW_KEY) {
  console.error("[orchestrator-smoke] CEREBRAS_API_KEY is required.");
  process.exit(1);
}

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
const TASK_PROMPT =
  process.env.OPENCODE_BENCH_TASK_PROMPT ??
  "Write a Python file fizzbuzz.py (1..30, standard rules), then run `python fizzbuzz.py` and report the output. Keep it short.";

const settings: Record<string, string> = {
  CEREBRAS_API_KEY: RAW_KEY,
  CEREBRAS_BASE_URL,
  CEREBRAS_MODEL: MODEL,
  ELIZA_ACP_DEFAULT_AGENT: "opencode",
  ELIZA_OPENCODE_LOCAL: "1",
  ELIZA_OPENCODE_BASE_URL: CEREBRAS_BASE_URL,
  ELIZA_OPENCODE_API_KEY: RAW_KEY,
  ELIZA_OPENCODE_MODEL_POWERFUL: MODEL,
  ELIZA_AGENT_ORCHESTRATOR: "1",
};

for (const [key, value] of Object.entries(settings)) {
  process.env[key] = value;
}

const runtime = {
  logger: {
    debug: (message: string, data?: unknown) =>
      console.debug(message, data ?? ""),
    info: (message: string, data?: unknown) =>
      console.info(message, data ?? ""),
    warn: (message: string, data?: unknown) =>
      console.warn(message, data ?? ""),
    error: (message: string, data?: unknown) =>
      console.error(message, data ?? ""),
  },
  getSetting: (key: string) => settings[key] ?? process.env[key],
  services: new Map<string, unknown[]>(),
} as unknown as IAgentRuntime;

const vendoredShimDir = resolveVendoredOpencodeShim();
const config = buildOpencodeSpawnConfig(runtime, process.env, MODEL);
const acpEnv = buildOpencodeAcpEnv(runtime, process.env, MODEL);

console.log("[orchestrator-smoke] OpenCode ACP preflight:");
console.log(
  JSON.stringify(
    {
      dryRun: DRY_RUN,
      vendoredShimDir: vendoredShimDir ?? null,
      provider: config?.providerLabel ?? null,
      model: config?.model ?? null,
      hasConfigContent: Boolean(acpEnv.env.OPENCODE_CONFIG_CONTENT),
    },
    null,
    2,
  ),
);

if (!vendoredShimDir) {
  console.error(
    "[orchestrator-smoke] vendored opencode is not initialized. Run `node scripts/ensure-opencode-submodule.mjs`.",
  );
  process.exit(2);
}

if (!config) {
  console.error("[orchestrator-smoke] OpenCode provider config was not built.");
  process.exit(3);
}

if (DRY_RUN) {
  console.log("[orchestrator-smoke] dry run ok.");
  process.exit(0);
}

await fs.mkdir(WORKDIR_ROOT, { recursive: true });
const sessionWorkdir = path.join(
  WORKDIR_ROOT,
  `session-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`,
);
await fs.mkdir(sessionWorkdir, { recursive: true });

const service = new AcpService(runtime);
await service.start();

try {
  console.log(
    `[orchestrator-smoke] creating OpenCode ACP session in ${sessionWorkdir}`,
  );
  const session = await service.spawnSession({
    name: `opencode-cerebras-${Date.now()}`,
    agentType: "opencode",
    workdir: sessionWorkdir,
    approvalPreset: "permissive",
    timeoutMs: SESSION_TIMEOUT_MS,
  });
  console.log(`[orchestrator-smoke] session id: ${session.sessionId}`);

  const result = await service.sendPrompt(session.sessionId, TASK_PROMPT, {
    timeoutMs: SESSION_TIMEOUT_MS,
  });
  console.log("[orchestrator-smoke] prompt result:");
  console.log(JSON.stringify(result, null, 2));

  const files = await fs.readdir(sessionWorkdir, { withFileTypes: true });
  console.log(
    `[orchestrator-smoke] files in ${sessionWorkdir}:`,
    files.map((file) => file.name),
  );

  const fizzbuzz = path.join(sessionWorkdir, "fizzbuzz.py");
  const exists = await fs
    .stat(fizzbuzz)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    console.log(
      `[orchestrator-smoke] fizzbuzz.py contents:\n${await fs.readFile(fizzbuzz, "utf8")}`,
    );
  }

  console.log(`[orchestrator-smoke] ${exists ? "SUCCESS" : "FAILURE"}`);
  process.exit(exists ? 0 : 4);
} finally {
  await service.stop();
}
