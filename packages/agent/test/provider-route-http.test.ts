/** Persisted provider routing across runtime startup and authenticated config writes. */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  type ElizaConfig,
  isLocalOnlyInferenceInConfig,
} from "@elizaos/host/protocol";
import { createTestRuntime } from "@elizaos/testing/runtime";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import openaiPlugin from "../../../plugins/plugin-openai/index.ts";
import {
  getApiKey,
  getBaseURL,
} from "../../../plugins/plugin-openai/utils/config.ts";
import { startApiServer } from "../src/api/server.ts";
import { loadElizaConfig, saveElizaConfig } from "../src/config/config.ts";
import { collectPluginNames } from "../src/runtime/plugin-collector.ts";
import { buildRuntimeSettingsProjection } from "../src/runtime/runtime-settings.ts";

let directory: string;
let configPath: string;
let fixture: Awaited<ReturnType<typeof createTestRuntime>>;
let server: Awaited<ReturnType<typeof startApiServer>>;
const token = randomUUID();
const openaiKey = "synthetic-openai-routing-credential";
const cerebrasKey = "synthetic-cerebras-routing-credential";
const config: ElizaConfig = {
  deploymentTarget: { runtime: "local" },
  cloud: {
    enabled: false,
    inferenceMode: "local",
    services: { inference: false },
  },
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
  const localOnlyInputs: ElizaConfig[] = [
    { cloud: { enabled: false }, serviceRouting: {} },
    { cloud: { inferenceMode: "local" } },
    { cloud: { services: { inference: false } } },
  ];
  for (const input of localOnlyInputs) {
    await writeFile(configPath, JSON.stringify({ ...input, env: config.env }));
    const selected = loadElizaConfig();
    expect(isLocalOnlyInferenceInConfig(selected)).toBe(true);
    expect(selected.serviceRouting).toEqual({});
    expect(selected.cloud?.inferenceMode).toBeUndefined();
    expect(selected.cloud?.services?.inference).toBeUndefined();
    for (const name of ["openai", "anthropic", "elizacloud"]) {
      expect(collectPluginNames(selected).has(`@elizaos/plugin-${name}`)).toBe(
        false,
      );
    }
    saveElizaConfig(selected);
    const reloaded = loadElizaConfig();
    expect(isLocalOnlyInferenceInConfig(reloaded)).toBe(true);
    expect(reloaded.serviceRouting).toEqual({});
    expect(reloaded.env?.vars).toMatchObject(config.env?.vars ?? {});
  }
  await writeFile(
    configPath,
    JSON.stringify({
      deploymentTarget: {
        runtime: "remote",
        provider: "remote",
        remoteApiBase: "https://remote.example",
      },
      cloud: { inferenceMode: "local" },
      env: config.env,
    }),
  );
  const remote = loadElizaConfig();
  expect(isLocalOnlyInferenceInConfig(remote)).toBe(false);
  expect(remote.serviceRouting?.llmText).toMatchObject({
    transport: "remote",
    remoteApiBase: "https://remote.example",
  });
  await writeFile(
    configPath,
    JSON.stringify({
      cloud: { inferenceMode: "byok" },
      env: config.env,
    }),
  );
  const direct = loadElizaConfig();
  expect(isLocalOnlyInferenceInConfig(direct)).toBe(false);
  expect(direct.serviceRouting?.llmText?.transport).toBe("direct");
  expect(collectPluginNames(direct).has("@elizaos/plugin-openai")).toBe(true);
  await writeFile(configPath, JSON.stringify(config));
  const loaded = loadElizaConfig();
  expect(loaded.cloud?.inferenceMode).toBeUndefined();
  expect(loaded.cloud?.services?.inference).toBeUndefined();
  expect(loaded.serviceRouting).toEqual(config.serviceRouting);
  for (const candidate of [config, loaded]) {
    const selected = collectPluginNames(candidate);
    expect(selected.has("@elizaos/plugin-openai")).toBe(true);
    expect(selected.has("@elizaos/plugin-elizacloud")).toBe(false);
  }
  fixture = await createTestRuntime({
    characterName: "ProviderRouteAcceptance",
    settings: buildRuntimeSettingsProjection(loaded),
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

it("retires a persisted ChatGPT/Codex subscription chat route while keeping the coding-agent credential", async () => {
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  saved.serviceRouting = {
    llmText: { backend: "openai-subscription", transport: "direct" },
  };
  saved.agents = {
    ...saved.agents,
    defaults: {
      ...saved.agents?.defaults,
      subscriptionProvider: "openai-codex",
      model: { primary: "codex-cli" },
    },
  };
  await writeFile(configPath, JSON.stringify(saved));
  expect((await request("/api/config/reload", "POST")).status).toBe(200);

  const models = await request("/api/models/config");
  expect(models.status).toBe(200);
  expect((await models.json()).activeChat?.provider).not.toBe("openai-codex");

  const configResponse = await request("/api/config");
  expect(configResponse.status).toBe(200);
  const migrated = await configResponse.json();
  expect(migrated.serviceRouting).toEqual({});
  expect(migrated.agents?.defaults?.model?.primary).toBeUndefined();
  expect(migrated.agents?.defaults?.subscriptionProvider).toBe("openai-codex");

  const rejected = await request("/api/provider/switch", "POST", {
    provider: "openai-subscription",
  });
  expect(rejected.status).toBe(400);
  expect(JSON.stringify(await rejected.json())).toContain(
    "ChatGPT/Codex subscription cannot power chat",
  );
});
