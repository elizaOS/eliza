import type http from "node:http";
import { createTestVault, type TestVault } from "@elizaos/auth/testing";
import { AgentRuntime, ModelType, type Plugin } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { anthropicPlugin } from "@elizaos/plugin-anthropic";
import { openaiPlugin } from "@elizaos/plugin-openai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { handleProviderSwitchRoutes } from "../src/api/provider-switch-routes.ts";
import type {
  RuntimeOperationManager,
  StartOperationRequest,
} from "../src/runtime/operations/types.ts";

let testVault: TestVault;
const savedEnv = { ...process.env };
const proxyEnvKeys = [
  "OPENAI_BASE_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ELIZAOS_CLOUD_API_KEY",
  "OPENAI_SMALL_MODEL",
  "OPENAI_LARGE_MODEL",
  "ANTHROPIC_SMALL_MODEL",
  "ANTHROPIC_LARGE_MODEL",
  "ELIZA_PROVIDER",
  "CEREBRAS_API_KEY",
  "EVOLINK_API_KEY",
  "ELIZA_MOCK_OPENAI_BASE",
  "ELIZA_MOCK_ANTHROPIC_BASE",
] as const;

beforeEach(async () => {
  for (const key of proxyEnvKeys) delete process.env[key];
  testVault = await createTestVault();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await testVault.dispose();
  process.env = { ...savedEnv };
});

async function switchProvider(
  config: ElizaConfig,
  body: { provider: string; apiKey: string },
): Promise<number> {
  let status = 0;
  const runtimeOperationManager = {
    start: async (request: StartOperationRequest) => {
      await request.prepare?.();
      return {
        kind: "accepted",
        operation: { id: `op-${body.provider}` },
      };
    },
  } as unknown as RuntimeOperationManager;

  await handleProviderSwitchRoutes({
    req: { headers: {} } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/provider/switch",
    state: { config },
    json: (_res, _data, code = 200) => {
      status = code;
    },
    error: (_res, _message, code = 500) => {
      status = code;
    },
    readJsonBody: async <T extends object>() => body as unknown as T,
    saveElizaConfig: () => {},
    scheduleRuntimeRestart: () => {},
    runtimeOperationManager,
    secretsManager: { vault: testVault.vault } as never,
  });
  return status;
}

it("stops routing OpenAI requests through the Eliza Cloud proxy after switching to OpenAI", async () => {
  const config = {} as ElizaConfig;

  expect(
    await switchProvider(config, {
      provider: "elizacloud",
      apiKey: "eliza_cloud_key_123",
    }),
  ).toBe(202);
  expect(process.env.OPENAI_BASE_URL).toBe("https://cloud.eliza.app/api/v1");

  expect(
    await switchProvider(config, {
      provider: "openai",
      apiKey: "sk-user-openai-key",
    }),
  ).toBe(202);

  expect({
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_LARGE_MODEL: process.env.OPENAI_LARGE_MODEL,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  }).toEqual({
    OPENAI_BASE_URL: undefined,
    OPENAI_API_KEY: "sk-user-openai-key",
    OPENAI_LARGE_MODEL: "gpt-5.6-sol",
    ANTHROPIC_BASE_URL: undefined,
    ANTHROPIC_API_KEY: undefined,
  });
});

it("stops routing Anthropic requests through the Eliza Cloud proxy after switching to Anthropic", async () => {
  const config = {} as ElizaConfig;

  await switchProvider(config, {
    provider: "elizacloud",
    apiKey: "eliza_cloud_key_123",
  });
  expect(
    await switchProvider(config, {
      provider: "anthropic",
      apiKey: "sk-ant-user-key",
    }),
  ).toBe(202);

  expect({
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  }).toEqual({
    ANTHROPIC_BASE_URL: undefined,
    ANTHROPIC_API_KEY: "sk-ant-user-key",
    OPENAI_BASE_URL: undefined,
    OPENAI_API_KEY: undefined,
  });
});

async function nextModelRequestHost(
  plugin: Plugin,
  runtime: AgentRuntime,
): Promise<string> {
  const hosts: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url =
        input instanceof Request ? input.url : new URL(String(input)).href;
      hosts.push(new URL(url).host);
      return new Response(
        JSON.stringify({
          error: { message: "invalid api key", type: "authentication_error" },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }),
  );
  const handler = plugin.models?.[ModelType.TEXT_SMALL];
  if (!handler) throw new Error(`${plugin.name} has no TEXT_SMALL handler`);
  await expect(
    handler(runtime, { prompt: "Reply briefly." }),
  ).rejects.toThrow();
  vi.unstubAllGlobals();
  return hosts[0] ?? "<no request>";
}

function createRuntime(): AgentRuntime {
  return new AgentRuntime({ character: { name: "ProviderSwitchRouting" } });
}

it.each([
  ["openai", openaiPlugin, "sk-user-openai-key", "api.openai.com"],
  ["anthropic", anthropicPlugin, "sk-ant-user-key", "api.anthropic.com"],
] as const)(
  "sends the next %s model request to the direct provider host after leaving Eliza Cloud",
  async (provider, plugin, apiKey, directHost) => {
    const config = {} as ElizaConfig;
    await switchProvider(config, {
      provider: "elizacloud",
      apiKey: "eliza_cloud_key_123",
    });
    const runtimeCreatedOnCloud = createRuntime();
    expect(await nextModelRequestHost(plugin, runtimeCreatedOnCloud)).toBe(
      "cloud.eliza.app",
    );

    expect(await switchProvider(config, { provider, apiKey })).toBe(202);

    expect({
      existingRuntime: await nextModelRequestHost(
        plugin,
        runtimeCreatedOnCloud,
      ),
      restartedRuntime: await nextModelRequestHost(plugin, createRuntime()),
    }).toEqual({
      existingRuntime: directHost,
      restartedRuntime: directHost,
    });
  },
);
