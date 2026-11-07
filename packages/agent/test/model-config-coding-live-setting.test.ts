/** Coding-target model config writes reach the running runtime without a restart. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { resolvePinnedAdapter } from "../../../plugins/plugin-agent-orchestrator/src/services/task-agent-routing.ts";
import { startApiServer } from "../src/api/server.ts";
import { loadElizaConfig } from "../src/config/config.ts";
import { buildRuntimeSettingsProjection } from "../src/runtime/runtime-settings.ts";

const KEY = "ELIZA_DEFAULT_AGENT_TYPE";
let directory: string;
let configPath: string;
let testRuntime: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
const token = randomUUID();

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-coding-live-"));
  configPath = path.join(directory, "eliza.json");
  const config: ElizaConfig = {
    deploymentTarget: { runtime: "local" },
    env: { vars: { [KEY]: "codex" } },
  };
  await writeFile(configPath, JSON.stringify(config));
  for (const key of [
    KEY,
    "ELIZA_AGENT_SELECTION_STRATEGY",
    "BENCHMARK_TASK_AGENT",
    "ELIZA_ACP_DEFAULT_AGENT",
    "ELIZA_CLAUDE_MODEL_POWERFUL",
  ])
    vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries({
    ELIZA_STATE_DIR: directory,
    ELIZA_CONFIG_PATH: configPath,
    ELIZA_PERSIST_CONFIG_PATH: configPath,
    ELIZA_API_BIND_HOST: "127.0.0.1",
    ELIZA_API_TOKEN: token,
    ELIZA_REQUIRE_LOCAL_AUTH: "1",
  }))
    vi.stubEnv(key, value);
  testRuntime = await createTestRuntime({
    characterName: "CodingLiveSetting",
    settings: buildRuntimeSettingsProjection(loadElizaConfig()),
  });
  server = await startApiServer({
    port: 0,
    runtime: testRuntime.runtime,
    skipDeferredStartupWork: true,
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (testRuntime) await testRuntime.cleanup();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

function postCodingConfig(body: object) {
  return fetch(`http://127.0.0.1:${server.port}/api/models/config`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    body: JSON.stringify({ target: "coding", ...body }),
  });
}

it("switches the live coding default without a restart", async () => {
  const { runtime } = testRuntime;
  expect(resolvePinnedAdapter(runtime)).toBe("codex");

  const response = await postCodingConfig({
    backend: "claude",
    model: "claude-opus-4-8",
    defaultBackend: "claude",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    applied: true,
    restart: false,
  });
  expect(JSON.parse(await readFile(configPath, "utf8")).env.vars[KEY]).toBe(
    "claude",
  );
  expect(resolvePinnedAdapter(runtime)).toBe("claude");
  expect(runtime.getSetting("ELIZA_CLAUDE_MODEL_POWERFUL")).toBe(
    "claude-opus-4-8",
  );
});

it("leaves a runtime value the previous config did not own", async () => {
  const { runtime } = testRuntime;
  runtime.setSetting(KEY, "elizaos");

  const response = await postCodingConfig({ defaultBackend: "codex" });
  expect(response.status).toBe(200);
  expect(JSON.parse(await readFile(configPath, "utf8")).env.vars[KEY]).toBe(
    "codex",
  );
  expect(runtime.getSetting(KEY)).toBe("elizaos");
  expect(resolvePinnedAdapter(runtime)).toBe("elizaos");
});
