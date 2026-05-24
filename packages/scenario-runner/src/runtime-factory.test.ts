import { ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  loadScenarioTestMocksForTests,
  resolveScenarioProviderConfig,
  shouldUseDeterministicLlmProxy,
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
