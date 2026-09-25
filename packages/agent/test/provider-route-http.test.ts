/** Persisted provider routing across runtime startup and authenticated config writes. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestRuntime } from "@elizaos/testing";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import openaiPlugin from "../../../plugins/plugin-openai/index.ts";
import {
  getApiKey,
  getBaseURL,
} from "../../../plugins/plugin-openai/utils/config.ts";
import { startApiServer } from "../src/api/server.ts";
import type { ElizaConfig } from "../src/config/config.ts";
import { buildRuntimeSettingsProjection } from "../src/runtime/runtime-settings.ts";

let directory: string;
let configPath: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
const token = randomUUID();
const openaiKey = "synthetic-openai-routing-credential";
const cerebrasKey = "synthetic-cerebras-routing-credential";
const config: ElizaConfig = {
  serviceRouting: {
    llmText: {
      backend: "cerebras",
      transport: "direct",
      primaryModel: "qwen-3.8-27b",
    },
  },
  env: {
    vars: {
      OPENAI_API_KEY: openaiKey,
      CEREBRAS_API_KEY: cerebrasKey,
      OPENAI_BASE_URL: "https://api.cerebras.ai/v1",
    },
  },
};

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "eliza-provider-route-"));
  configPath = path.join(directory, "eliza.json");
  await writeFile(configPath, JSON.stringify(config));
  for (const key of [
    "ELIZA_PROVIDER",
    "OPENAI_BASE_URL",
    "CEREBRAS_BASE_URL",
    "ELIZA_MOCK_OPENAI_BASE",
    "ELIZA_BRAIN_PROVIDER",
    "ELIZA_CLOUD_PROVISIONED",
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
  fixture = await createTestRuntime({
    characterName: "ProviderRouteAcceptance",
    settings: buildRuntimeSettingsProjection(config),
    plugins: [openaiPlugin],
  });
  server = await startApiServer({
    port: 0,
    runtime: fixture.runtime,
    skipDeferredStartupWork: true,
  });
}, 120_000);

afterAll(async () => {
  if (server) await server.close();
  if (fixture) await fixture.cleanup();
  vi.unstubAllEnvs();
  if (directory) await rm(directory, { recursive: true, force: true });
}, 120_000);

function request(route: string, method = "GET", body?: object) {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "x-forwarded-for": "203.0.113.10",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

it("serves the explicit backend despite another stored credential, switches through HTTP, and releases compatible-provider pins when changing provider families", async () => {
  const assertProvider = async (
    provider: string,
    endpoint: string,
    key: string,
  ) => {
    const response = await request("/api/models/config");
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.activeChat).toMatchObject({ provider, endpoint });
    expect(getBaseURL(fixture.runtime)).toBe(`https://${endpoint}/v1`);
    expect(getApiKey(fixture.runtime)).toBe(key);
    expect(JSON.stringify(data)).not.toContain(openaiKey);
    expect(JSON.stringify(data)).not.toContain(cerebrasKey);
  };
  await assertProvider("cerebras", "api.cerebras.ai", cerebrasKey);
  expect(
    (
      await request("/api/config", "PUT", {
        serviceRouting: {
          llmText: {
            backend: "openai",
            transport: "direct",
            primaryModel: "gpt-4.1-mini",
          },
        },
      })
    ).status,
  ).toBe(200);
  await assertProvider("openai", "api.openai.com", openaiKey);
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  expect(saved.env.vars.OPENAI_API_KEY).toBe(openaiKey);
  expect(saved.env.vars.CEREBRAS_API_KEY).toBe(cerebrasKey);
  expect(saved.env.vars.ELIZA_PROVIDER).toBeUndefined();
  saved.serviceRouting.llmText = config.serviceRouting?.llmText;
  await writeFile(configPath, JSON.stringify(saved));
  expect((await request("/api/config/reload", "POST")).status).toBe(200);
  await assertProvider("cerebras", "api.cerebras.ai", cerebrasKey);
  saved.serviceRouting = {
    llmText: { backend: "anthropic", transport: "direct" },
  };
  await writeFile(configPath, JSON.stringify(saved));
  expect((await request("/api/config/reload", "POST")).status).toBe(200);
  expect(fixture.runtime.getSetting("ELIZA_PROVIDER")).toBeNull();
  expect(getBaseURL(fixture.runtime)).toBe("https://api.cerebras.ai/v1");
  expect(getApiKey(fixture.runtime)).toBe(cerebrasKey);
});
