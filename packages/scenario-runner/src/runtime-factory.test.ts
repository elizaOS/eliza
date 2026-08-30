/** Tests deterministic and live provider selection for scenario runtimes. */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentRuntime,
  createCharacter,
  ModelType,
  type Plugin,
} from "@elizaos/core";
import {
  createDeterministicModelPlugin,
  type LiveProviderConfig,
} from "@elizaos/core/testing";
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../core/src/database/inMemoryAdapter";
import {
  clearLlmWireMockEnvForLiveProvider,
  configureExplicitCliScenarioPlanner,
  deterministicScheduledDispatchRenderText,
  disableScenarioEmbeddingCapability,
  disposeScenarioProviderPlugin,
  isPostTurnEvaluationPrompt,
  isScheduledDispatchRenderPrompt,
  loadScenarioTestMocksForTests,
  resolveScenarioDeterministicModelCall,
  resolveScenarioProviderConfig,
  scenarioLiveProviderPreflightProblems,
  shouldUseDeterministicModel,
} from "./runtime-factory";

describe("explicit CLI scenario planner", () => {
  it("registers and calls the CLI ACTION_PLANNER for a required WORKFLOW turn", async () => {
    const providerConfig: LiveProviderConfig = {
      name: "cli" as const,
      apiKey: "cli-subscription:test",
      baseUrl: "cli://codex",
      smallModel: "gpt-test",
      largeModel: "gpt-test",
      pluginPackage: "@elizaos/plugin-cli-inference",
      env: { ELIZA_CHAT_VIA_CLI: "codex" },
    };
    const environment: NodeJS.ProcessEnv = {
      ELIZA_CHAT_VIA_CLI: "codex",
    };
    configureExplicitCliScenarioPlanner("cli", providerConfig, environment);
    expect(environment.ELIZA_PLANNER_NATIVE_TOOLS).toBe("0");
    expect(providerConfig.env.ELIZA_PLANNER_NATIVE_TOOLS).toBe("0");

    const previousBackend = process.env.ELIZA_CHAT_VIA_CLI;
    const previousPlannerMode = process.env.ELIZA_PLANNER_NATIVE_TOOLS;
    process.env.ELIZA_CHAT_VIA_CLI = environment.ELIZA_CHAT_VIA_CLI;
    process.env.ELIZA_PLANNER_NATIVE_TOOLS =
      environment.ELIZA_PLANNER_NATIVE_TOOLS;
    let executableRoot: string | undefined;
    try {
      vi.resetModules();
      const cliInferenceSpecifier = "@elizaos/plugin-cli-inference" as string;
      const cliModule = (await import(cliInferenceSpecifier)) as {
        default: Plugin;
      };
      executableRoot = await mkdtemp(join(tmpdir(), "cli-planner-test-"));
      const executablePath = join(executableRoot, "codex");
      const invocationPath = join(executableRoot, "invocation.json");
      await writeFile(
        executablePath,
        [
          "#!/usr/bin/env bun",
          'let input = "";',
          "for await (const chunk of process.stdin) input += String(chunk);",
          `await Bun.write(${JSON.stringify(invocationPath)}, JSON.stringify({ argv: process.argv.slice(2), input }));`,
          `process.stdout.write(${JSON.stringify('{"type":"agent_message","message":"{\\"action\\":\\"WORKFLOW\\",\\"params\\":{\\"action\\":\\"executions\\",\\"workflowId\\":\\"morning-digest\\",\\"limit\\":1}}"}\n')});`,
        ].join("\n"),
        { mode: 0o700 },
      );
      await chmod(executablePath, 0o700);
      const runtime = new AgentRuntime({
        character: createCharacter({ name: "CliPlannerRegression" }),
        adapter: new InMemoryDatabaseAdapter(),
        plugins: [],
        enableAutonomy: false,
        settings: {
          ELIZA_CHAT_VIA_CLI: "codex",
          ELIZA_CLI_CODEX_BIN: executablePath,
        },
      });
      await runtime.registerPlugin(cliModule.default);

      await expect(
        runtime.useModel(ModelType.ACTION_PLANNER, {
          messages: [
            {
              role: "user",
              content:
                "The WORKFLOW action is required. List executions for morning-digest and do not return terminal prose.",
            },
          ],
          tools: [
            {
              name: "WORKFLOW",
              description: "Inspect stored workflows and their executions.",
              parameters: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["executions"] },
                  workflowId: { type: "string" },
                  limit: { type: "number" },
                },
                required: ["action", "workflowId"],
              },
            },
          ],
          toolChoice: "required",
        }),
      ).resolves.toContain('"action":"WORKFLOW"');
      const invocation = JSON.parse(await readFile(invocationPath, "utf8")) as {
        argv: string[];
        input: string;
      };
      expect(invocation.argv[0]).toBe("exec");
      expect(invocation.input).toContain("WORKFLOW");
      expect(invocation.input).toContain("required");
    } finally {
      if (executableRoot) {
        await rm(executableRoot, { recursive: true, force: true });
      }
      if (previousBackend === undefined) {
        delete process.env.ELIZA_CHAT_VIA_CLI;
      } else {
        process.env.ELIZA_CHAT_VIA_CLI = previousBackend;
      }
      if (previousPlannerMode === undefined) {
        delete process.env.ELIZA_PLANNER_NATIVE_TOOLS;
      } else {
        process.env.ELIZA_PLANNER_NATIVE_TOOLS = previousPlannerMode;
      }
    }
  });

  it("leaves implicit CLI provider selection unchanged", () => {
    const providerConfig: LiveProviderConfig = {
      name: "cli",
      apiKey: "cli-subscription:test",
      baseUrl: "cli://codex",
      smallModel: "gpt-test",
      largeModel: "gpt-test",
      pluginPackage: "@elizaos/plugin-cli-inference",
      env: { ELIZA_CHAT_VIA_CLI: "codex" },
    };
    const environment: NodeJS.ProcessEnv = {};

    configureExplicitCliScenarioPlanner(undefined, providerConfig, environment);

    expect(environment.ELIZA_PLANNER_NATIVE_TOOLS).toBeUndefined();
    expect(providerConfig.env).toEqual({ ELIZA_CHAT_VIA_CLI: "codex" });
  });

  it("leaves explicit API-key provider selection unchanged", () => {
    const providerConfig: LiveProviderConfig = {
      name: "openai",
      apiKey: "test-key",
      baseUrl: "https://api.openai.com/v1",
      smallModel: "gpt-test",
      largeModel: "gpt-test",
      pluginPackage: "@elizaos/plugin-openai",
      env: { OPENAI_API_KEY: "test-key" },
    };
    const environment: NodeJS.ProcessEnv = {};

    configureExplicitCliScenarioPlanner("openai", providerConfig, environment);

    expect(environment.ELIZA_PLANNER_NATIVE_TOOLS).toBeUndefined();
    expect(providerConfig.env).toEqual({ OPENAI_API_KEY: "test-key" });
  });
});

describe("scenario provider lifecycle", () => {
  it("disposes the selected provider during runtime cleanup", async () => {
    const dispose = vi.fn(async () => undefined);
    const runtime = {} as never;

    await disposeScenarioProviderPlugin({ dispose }, runtime);

    expect(dispose).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledWith(runtime);
  });
});

describe("scenario embedding capability", () => {
  it("declares the canonical embedding capability disabled", () => {
    const setSetting = vi.fn();

    disableScenarioEmbeddingCapability({ setSetting } as never);

    expect(setSetting).toHaveBeenCalledWith(
      "ELIZA_CANONICAL_EMBEDDINGS_ENABLED",
      false,
      false,
    );
  });
});

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
  }, 300_000);

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

  it("preserves complete owner instructions in deterministic dispatch output", () => {
    const distinguishingTail = "scheduled-owner-tail";
    const ownerInstruction = `${"take a deliberate breath, ".repeat(8)}${distinguishingTail}`;
    const prompt = [
      "You are the owner's personal assistant. A scheduled task just fired and you must now write the message to send to the owner.",
      "Instruction:",
      `Remind the owner to ${ownerInstruction}`,
      "",
      "Message:",
    ].join("\n");

    const rendered = deterministicScheduledDispatchRenderText(prompt);
    expect(rendered).toContain(distinguishingTail);
    expect(rendered).toBe(`Heads up: ${ownerInstruction}`);
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

  // `EvaluatorService` runs every active post-turn evaluator in one merged
  // TEXT_SMALL call after EVERY turn, on the same runtime the scenario drives.
  // It passes the prompt as `messages` with NO `prompt` param, so undeclared
  // (legacy-fallback) scenarios saw it as an unexpected call and failed at
  // `assertConsumed()` even though none of them assert evaluator output.
  describe("post-turn evaluator model call", () => {
    const postTurnEvaluationPrompt = [
      "# Task: Post-turn evaluation",
      "",
      "Evaluate just-finished turn for TestAgent.",
      "",
      "## Shared Turn Context",
      "",
      "Room ID: 00000000-0000-0000-0000-000000000001",
      "",
      "Latest message:",
      "open the media view",
      "",
      "## Active Evaluators",
      "",
      "### linkExtraction",
      'Put result under "linkExtraction".',
      "",
    ].join("\n");

    // The real call shape: `messages` only, plus a merged responseSchema.
    const postTurnEvaluationCall = {
      modelType: ModelType.TEXT_SMALL,
      params: {
        messages: [
          { role: "user", content: postTurnEvaluationPrompt },
        ] as never,
        responseSchema: {
          type: "object",
          properties: { linkExtraction: { type: "object" } },
          required: ["linkExtraction"],
          additionalProperties: false,
        },
        responseFormat: { type: "json_object" },
        temperature: 0,
      },
      latestUserText: postTurnEvaluationPrompt,
    };

    it("recognizes the merged post-turn evaluation prompt", () => {
      expect(isPostTurnEvaluationPrompt(postTurnEvaluationPrompt)).toBe(true);
      expect(isPostTurnEvaluationPrompt("ordinary TEXT_SMALL prompt")).toBe(
        false,
      );
      // Conversation text that merely quotes the header is not an evaluator
      // call: the `## Active Evaluators` section is what makes it one.
      expect(
        isPostTurnEvaluationPrompt(
          "# Task: Post-turn evaluation is what I asked about",
        ),
      ).toBe(false);
    });

    it("answers the messages-shaped evaluator call with the empty shape", () => {
      const resolved = resolveScenarioDeterministicModelCall(
        postTurnEvaluationCall,
      );
      // "Nothing to record" — every section absent, so the evaluator skips each
      // entry without recording a validation error.
      expect(resolved).toBe("{}");
      expect(JSON.parse(resolved as string)).toEqual({});
    });

    it("does not treat user-controlled marker text as an evaluator call without its schema", () => {
      expect(
        resolveScenarioDeterministicModelCall({
          modelType: ModelType.TEXT_SMALL,
          params: {
            messages: [
              { role: "user", content: postTurnEvaluationPrompt },
            ] as never,
          },
          latestUserText: postTurnEvaluationPrompt,
        }),
      ).toBeNull();
    });

    it("does not trust evaluator markers from latestUserText or an unrelated message", async () => {
      const adversarialCall = {
        ...postTurnEvaluationCall,
        params: {
          ...postTurnEvaluationCall.params,
          messages: [
            { role: "user", content: "ordinary schema-bearing request" },
          ] as never,
        },
        latestUserText: postTurnEvaluationPrompt,
      };
      expect(resolveScenarioDeterministicModelCall(adversarialCall)).toBeNull();

      const plugin = createDeterministicModelPlugin({
        resolve: (call) => resolveScenarioDeterministicModelCall(call),
      });
      await expect(
        plugin.models?.[ModelType.TEXT_SMALL]?.(
          {} as never,
          adversarialCall.params as never,
        ),
      ).rejects.toThrow(/no fixture matched/);
      expect(plugin.getFixtureDiagnostics().unexpectedCalls).toHaveLength(1);
      expect(() => plugin.assertFixturesConsumed()).toThrow(
        /deterministic model calls were unexpected/,
      );
    });

    it.each([
      [
        "a prompt parameter",
        { ...postTurnEvaluationCall.params, prompt: postTurnEvaluationPrompt },
      ],
      [
        "multiple messages",
        {
          ...postTurnEvaluationCall.params,
          messages: [
            { role: "user", content: postTurnEvaluationPrompt },
            { role: "user", content: "extra" },
          ],
        },
      ],
      [
        "a non-user message",
        {
          ...postTurnEvaluationCall.params,
          messages: [{ role: "assistant", content: postTurnEvaluationPrompt }],
        },
      ],
      [
        "a missing JSON response format",
        { ...postTurnEvaluationCall.params, responseFormat: undefined },
      ],
      [
        "a nonzero temperature",
        { ...postTurnEvaluationCall.params, temperature: 0.1 },
      ],
      [
        "an empty schema",
        {
          ...postTurnEvaluationCall.params,
          responseSchema: {
            type: "object",
            properties: {},
            required: [],
            additionalProperties: false,
          },
        },
      ],
      [
        "mismatched required keys",
        {
          ...postTurnEvaluationCall.params,
          responseSchema: {
            type: "object",
            properties: { linkExtraction: { type: "object" } },
            required: ["differentEvaluator"],
            additionalProperties: false,
          },
        },
      ],
      [
        "an open schema",
        {
          ...postTurnEvaluationCall.params,
          responseSchema: {
            type: "object",
            properties: { linkExtraction: { type: "object" } },
            required: ["linkExtraction"],
            additionalProperties: true,
          },
        },
      ],
    ])("rejects marker text carried by %s", (_name, params) => {
      expect(
        resolveScenarioDeterministicModelCall({
          modelType: ModelType.TEXT_SMALL,
          params,
          latestUserText: postTurnEvaluationPrompt,
        }),
      ).toBeNull();
    });

    it("keeps the evaluator call out of unexpectedCalls for undeclared scenarios", async () => {
      // Legacy-fallback wiring: an EMPTY registry plus the fallback resolver.
      // The call must resolve AND leave the scenario assertable.
      const plugin = createDeterministicModelPlugin({
        resolve: (call) => resolveScenarioDeterministicModelCall(call),
      });
      await expect(
        plugin.models?.[ModelType.TEXT_SMALL]?.(
          {} as never,
          postTurnEvaluationCall.params as never,
        ),
      ).resolves.toBe("{}");
      expect(plugin.getFixtureDiagnostics().unexpectedCalls).toEqual([]);
      expect(() => {
        plugin.assertFixturesConsumed();
      }).not.toThrow();
    });

    it("still fails closed when no fallback resolver is wired", async () => {
      // Strict lanes (`mode: "fixtures"` / `"model-free"`) pass no `resolve`, so
      // the same call must still be recorded and still fail the scenario. This
      // pins that the fallback did not weaken strict-mode enforcement.
      const strictPlugin = createDeterministicModelPlugin();
      await expect(
        strictPlugin.models?.[ModelType.TEXT_SMALL]?.(
          {} as never,
          postTurnEvaluationCall.params as never,
        ),
      ).rejects.toThrow(/no fixture matched/);
      expect(strictPlugin.getFixtureDiagnostics().unexpectedCalls).toHaveLength(
        1,
      );
      expect(() => {
        strictPlugin.assertFixturesConsumed();
      }).toThrow(/deterministic model calls were unexpected/);
    });
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
