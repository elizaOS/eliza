/** Tests deterministic and live provider selection for scenario runtimes. */
import { ModelType } from "@elizaos/core";
import { createDeterministicModelPlugin } from "@elizaos/core/testing";
import { describe, expect, it } from "vitest";
import {
  clearLlmWireMockEnvForLiveProvider,
  deterministicScheduledDispatchRenderText,
  isScheduledDispatchRenderPrompt,
  loadScenarioTestMocksForTests,
  resolveScenarioDeterministicModelCall,
  resolveScenarioProviderConfig,
  scenarioLiveProviderPreflightProblems,
  shouldUseDeterministicModel,
} from "./runtime-factory";

describe("scenario live provider preflight", () => {
  const cerebrasActingConfig = {
    name: "openai" as const,
    apiKey: "acting-key",
    baseUrl: "https://api.cerebras.ai/v1",
    smallModel: "acting-model",
    largeModel: "acting-model",
    pluginPackage: "@elizaos/plugin-openai",
    env: { ELIZA_PROVIDER: "cerebras" },
  };

  it.each([undefined, "   "])(
    "rejects an explicitly selected OpenAI planner when OPENAI_API_KEY is %s",
    (openaiKey) => {
      const env = {
        OPENAI_API_KEY: openaiKey,
        CEREBRAS_API_KEY: "judge-key",
        SCENARIO_JUDGE_REQUIRE_INDEPENDENT: "1",
      };

      expect(
        scenarioLiveProviderPreflightProblems(
          "openai",
          cerebrasActingConfig,
          env,
        ),
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("--provider openai requires OPENAI_API_KEY"),
          expect.stringContaining(
            "acting provider cerebras cannot also be the independent judge provider",
          ),
        ]),
      );
    },
  );

  it("accepts exact planner and distinct judge identities", () => {
    expect(
      scenarioLiveProviderPreflightProblems(
        "openai",
        {
          ...cerebrasActingConfig,
          apiKey: "openai-key",
          baseUrl: "https://api.openai.com/v1",
          env: {},
        },
        {
          OPENAI_API_KEY: "openai-key",
          CEREBRAS_API_KEY: "judge-key",
          SCENARIO_JUDGE_REQUIRE_INDEPENDENT: "1",
        },
      ),
    ).toEqual([]);
  });

  it("rejects strict same-provider judging even when the acting key is populated", () => {
    expect(
      scenarioLiveProviderPreflightProblems(undefined, cerebrasActingConfig, {
        CEREBRAS_API_KEY: "shared-key",
        SCENARIO_JUDGE_REQUIRE_INDEPENDENT: "1",
      }),
    ).toContain(
      "acting provider cerebras cannot also be the independent judge provider",
    );
  });
});

describe("scenario runtime deterministic model mode", () => {
  it("can be enabled explicitly through runtime options", () => {
    expect(
      shouldUseDeterministicModel({ useDeterministicModel: true }, {}),
    ).toBe(true);
  });

  it.each([
    "SCENARIO_USE_DETERMINISTIC_MODEL",
    "ELIZA_SCENARIO_USE_DETERMINISTIC_MODEL",
  ])("can be enabled by %s", (name) => {
    expect(shouldUseDeterministicModel({}, { [name]: "1" })).toBe(true);
  });

  it("resolves a no-key deterministic provider config", () => {
    const providerConfig = resolveScenarioProviderConfig(
      { useDeterministicModel: true },
      {},
    );

    expect(providerConfig).toEqual({
      name: "deterministic-model-provider",
      env: {},
      pluginPackage: null,
    });
  });

  it("rejects an explicit live provider when deterministic mode is enabled", () => {
    expect(() =>
      resolveScenarioProviderConfig(
        { preferredProvider: "openai", useDeterministicModel: true },
        {},
      ),
    ).toThrow(/cannot be combined with the deterministic model provider/);
  });

  it("loads scenario test helpers while the model provider comes from core testing", async () => {
    const helpers = await loadScenarioTestMocksForTests();

    expect(helpers.prepareMockedTestEnvironment).toBeTypeOf("function");
    expect(helpers.seedLifeOpsSimulatorRuntime).toBeTypeOf("function");
    expect(helpers.seedBenchmarkLifeOpsFixtures).toBeTypeOf("function");
    expect(helpers.seedGoogleConnectorGrant).toBeTypeOf("function");
    expect(helpers.seedXConnectorGrant).toBeTypeOf("function");

    const plugin = createDeterministicModelPlugin({
      fixtures: [
        {
          name: "small",
          match: { modelType: ModelType.TEXT_SMALL },
          response: "declared response",
        },
      ],
    });
    expect(plugin.name).toBe("deterministic-model-provider");
    await expect(
      plugin.models?.[ModelType.TEXT_SMALL]?.(
        {} as never,
        {
          messages: [{ role: "user", content: "open view manager" }],
        } as never,
      ),
    ).resolves.toBe("declared response");
    expect(plugin.models?.[ModelType.TEXT_EMBEDDING]).toBeUndefined();
  });

  it("recognizes scheduled-dispatch render prompts and returns deterministic owner-facing text", () => {
    const prompt = [
      "You are the owner's personal assistant. A scheduled task just fired and you must now write the message to send to the owner.",
      "The instruction below tells you what to communicate. It is an instruction to you, not the message itself — never repeat or quote it verbatim.",
      "Write only the message body, speaking directly to the owner in a natural assistant voice.",
      "Do not mention scheduled tasks, instructions, or that this message was automated. No preamble, no markdown fences, no meta commentary.",
      "",
      "Instruction:",
      "Remind the owner to stretch for five minutes.",
      "",
      "Fired at: 2026-07-05T09:00:00.000Z",
      "",
      "Message:",
    ].join("\n");

    expect(isScheduledDispatchRenderPrompt(prompt)).toBe(true);
    // The deterministic render de-frames the instruction and prefixes it so
    // the copy stays exactly assertable while never equaling the raw
    // instruction (the renderer's instruction-echo guard rejects that).
    expect(deterministicScheduledDispatchRenderText(prompt)).toBe(
      "Heads up: stretch for five minutes.",
    );
    expect(deterministicScheduledDispatchRenderText(prompt)).not.toContain(
      "Remind the owner",
    );
    expect(isScheduledDispatchRenderPrompt("ordinary TEXT_LARGE prompt")).toBe(
      false,
    );
  });

  it("resolves the scheduled-dispatch render model call outside the fixture registry", () => {
    const prompt = [
      "You are the owner's personal assistant. A scheduled task just fired and you must now write the message to send to the owner.",
      "The instruction below tells you what to communicate. It is an instruction to you, not the message itself — never repeat or quote it verbatim.",
      "Write only the message body, speaking directly to the owner in a natural assistant voice.",
      "Do not mention scheduled tasks, instructions, or that this message was automated. No preamble, no markdown fences, no meta commentary.",
      "",
      "Instruction:",
      "Ask the owner to take a short walk.",
      "",
      "Fired at: 2026-07-05T09:00:00.000Z",
      "",
      "Message:",
    ].join("\n");

    expect(
      resolveScenarioDeterministicModelCall({
        modelType: ModelType.TEXT_LARGE,
        params: { prompt },
        latestUserText: "",
      }),
    ).toBe("Heads up: take a short walk.");
    expect(
      resolveScenarioDeterministicModelCall({
        modelType: ModelType.TEXT_LARGE,
        params: {
          messages: [
            { role: "user", content: [{ type: "text", text: prompt }] },
          ],
        },
        latestUserText: "",
      }),
    ).toBe("Heads up: take a short walk.");
    // The dispatch renderer voices through TEXT_SMALL; the resolver answers it
    // the same way it answers legacy TEXT_LARGE callers.
    expect(
      resolveScenarioDeterministicModelCall({
        modelType: ModelType.TEXT_SMALL,
        params: { prompt },
        latestUserText: "",
      }),
    ).toBe("Heads up: take a short walk.");
  });
});

describe("clearLlmWireMockEnvForLiveProvider", () => {
  const mockEnv = () => ({
    ELIZA_MOCK_OPENAI_BASE: "http://127.0.0.1:50101/v1",
    ELIZA_MOCK_ANTHROPIC_BASE: "http://127.0.0.1:50102/v1",
    ELIZA_MOCK_GOOGLE_BASE: "http://127.0.0.1:50103",
  });

  it.each(["openai", "anthropic", "groq", "google", "openrouter"] as const)(
    "drops the LLM wire-mock base overrides for the live %s provider",
    (providerName) => {
      const env = mockEnv();
      clearLlmWireMockEnvForLiveProvider(providerName, env);
      expect(env.ELIZA_MOCK_OPENAI_BASE).toBeUndefined();
      expect(env.ELIZA_MOCK_ANTHROPIC_BASE).toBeUndefined();
      // Connector mocks are unrelated to the LLM path and must survive.
      expect(env.ELIZA_MOCK_GOOGLE_BASE).toBe("http://127.0.0.1:50103");
    },
  );

  it("keeps the LLM wire mocks for the deterministic provider lane", () => {
    const env = mockEnv();
    clearLlmWireMockEnvForLiveProvider("deterministic-model-provider", env);
    expect(env.ELIZA_MOCK_OPENAI_BASE).toBe("http://127.0.0.1:50101/v1");
    expect(env.ELIZA_MOCK_ANTHROPIC_BASE).toBe("http://127.0.0.1:50102/v1");
    expect(env.ELIZA_MOCK_GOOGLE_BASE).toBe("http://127.0.0.1:50103");
  });
});
