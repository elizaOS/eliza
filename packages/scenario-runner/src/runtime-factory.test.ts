/** Tests the runtime factory's provider-selection logic (runtime-factory.ts): when deterministic LLM proxy vs strict-proxy vs live provider is chosen from env/options, and how live-provider config resolves. */
import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  clearLlmWireMockEnvForLiveProvider,
  loadScenarioTestMocksForTests,
  resolveScenarioProviderConfig,
  shouldUseDeterministicLlmProxy,
  shouldUseStrictDeterministicLlmProxy,
} from "./runtime-factory";

describe("scenario runtime deterministic LLM proxy mode", () => {
  it("can be enabled explicitly through runtime options", () => {
    expect(
      shouldUseDeterministicLlmProxy({ useDeterministicLlmProxy: true }, {}),
    ).toBe(true);
  });

  it.each([
    "SCENARIO_USE_LLM_PROXY",
    "ELIZA_SCENARIO_USE_LLM_PROXY",
  ])("can be enabled by %s", (name) => {
    expect(shouldUseDeterministicLlmProxy({}, { [name]: "1" })).toBe(true);
  });

  it.each([
    "SCENARIO_LLM_PROXY_STRICT",
    "ELIZA_SCENARIO_LLM_PROXY_STRICT",
  ])("can enable strict fixture mode by %s", (name) => {
    expect(shouldUseStrictDeterministicLlmProxy({ [name]: "true" })).toBe(true);
  });

  it("resolves a no-key deterministic provider config in proxy mode", () => {
    const providerConfig = resolveScenarioProviderConfig(
      { useDeterministicLlmProxy: true },
      {},
    );

    expect(providerConfig).toEqual({
      name: "deterministic-llm-proxy",
      env: {},
      pluginPackage: null,
    });
  });

  it("loads the scenario test helpers and deterministic proxy plugin from package paths", async () => {
    const helpers = await loadScenarioTestMocksForTests();

    expect(helpers.prepareMockedTestEnvironment).toBeTypeOf("function");
    expect(helpers.seedLifeOpsSimulatorRuntime).toBeTypeOf("function");
    expect(helpers.seedBenchmarkLifeOpsFixtures).toBeTypeOf("function");
    expect(helpers.seedGoogleConnectorGrant).toBeTypeOf("function");
    expect(helpers.seedXConnectorGrant).toBeTypeOf("function");

    const plugin = helpers.createDeterministicLlmProxyPlugin({
      embeddingDimensions: 3,
    });
    expect(plugin.name).toBe("deterministic-llm-proxy");
    await expect(
      plugin.models?.[ModelType.TEXT_SMALL]?.({} as never, {
        messages: [{ role: "user", content: "open view manager" }],
      }),
    ).resolves.toBe("deterministic-test-response: open view manager");
    await expect(
      plugin.models?.[ModelType.TEXT_EMBEDDING]?.({} as never, "hello"),
    ).resolves.toEqual([0, 0, 0]);
  });
});

describe("clearLlmWireMockEnvForLiveProvider", () => {
  const mockEnv = () => ({
    ELIZA_MOCK_OPENAI_BASE: "http://127.0.0.1:50101/v1",
    ELIZA_MOCK_ANTHROPIC_BASE: "http://127.0.0.1:50102/v1",
    ELIZA_MOCK_GOOGLE_BASE: "http://127.0.0.1:50103",
  });

  it.each([
    "openai",
    "anthropic",
    "groq",
    "google",
    "openrouter",
  ] as const)("drops the LLM wire-mock base overrides for the live %s provider", (providerName) => {
    const env = mockEnv();
    clearLlmWireMockEnvForLiveProvider(providerName, env);
    expect(env.ELIZA_MOCK_OPENAI_BASE).toBeUndefined();
    expect(env.ELIZA_MOCK_ANTHROPIC_BASE).toBeUndefined();
    // Connector mocks are unrelated to the LLM path and must survive.
    expect(env.ELIZA_MOCK_GOOGLE_BASE).toBe("http://127.0.0.1:50103");
  });

  it("keeps the LLM wire mocks for the deterministic proxy lane", () => {
    const env = mockEnv();
    clearLlmWireMockEnvForLiveProvider("deterministic-llm-proxy", env);
    expect(env.ELIZA_MOCK_OPENAI_BASE).toBe("http://127.0.0.1:50101/v1");
    expect(env.ELIZA_MOCK_ANTHROPIC_BASE).toBe("http://127.0.0.1:50102/v1");
    expect(env.ELIZA_MOCK_GOOGLE_BASE).toBe("http://127.0.0.1:50103");
  });
});
