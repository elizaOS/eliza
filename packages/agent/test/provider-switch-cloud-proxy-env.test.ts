import type http from "node:http";
import { createTestVault, type TestVault } from "@elizaos/auth/testing";
import type { ElizaConfig } from "@elizaos/host/protocol";
import { afterEach, beforeEach, expect, it } from "vitest";
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
] as const;

beforeEach(async () => {
  for (const key of proxyEnvKeys) delete process.env[key];
  testVault = await createTestVault();
});

afterEach(async () => {
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
