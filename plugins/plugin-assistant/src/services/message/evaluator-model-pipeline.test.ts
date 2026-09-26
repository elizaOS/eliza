/** Exercises both real message-pipeline evaluator call sites; no provider or app I/O. */
import {
  ChannelType,
  type GenerateTextParams,
  type IAgentRuntime,
  type Memory,
  ModelType,
  ResponseHandlerFieldRegistry,
  type State,
  type UUID,
} from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS } from "../../runtime/builtin-field-evaluators.ts";
import { runV5MessageRuntimeStage1 } from "./pipeline.ts";

afterEach(() => vi.unstubAllEnvs());

it.each(
  [false, true].flatMap((direct) =>
    ["runtime", "environment", "unset"].map((setting) => ({ direct, setting })),
  ),
)(
  "forwards evaluator selection and metadata through pipeline (direct=$direct, setting=$setting)",
  async ({ direct, setting }) => {
    vi.stubEnv(
      "ELIZA_EVALUATOR_MODEL",
      setting === "environment"
        ? "gpt-oss-120b"
        : setting === "runtime"
          ? "environment-must-not-win"
          : undefined,
    );
    const state: State = { values: {}, data: {}, text: "" };
    const id = (n: string) =>
      `00000000-0000-4000-8000-${n.padStart(12, "0")}` as UUID;
    const message: Memory = {
      id: id("1"),
      entityId: id("2"),
      agentId: id("3"),
      roomId: id("4"),
      content: {
        text: "Read the fixture record.",
        source: "test",
        channelType: ChannelType.DM,
      },
    };
    const fields = new ResponseHandlerFieldRegistry();
    for (const field of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS)
      fields.register(field);
    const calls: Array<{ type: string; model?: string }> = [];
    const read = vi.fn(async () => ({
      success: true,
      transcriptVisibility: "internal",
      modelReplyRequired: true,
      data: {
        actionName: "READ_RECORD",
        readOnlyOperation: true,
        value: "amber",
      },
    }));
    let handlerCalls = 0;
    let evaluatorCalls = 0;
    const getSetting = vi.fn(function (this: IAgentRuntime, key: string) {
      expect(this).toBe(runtime);
      return key === "ELIZA_EVALUATOR_MODEL" && setting === "runtime"
        ? "gpt-oss-120b"
        : null;
    });
    const getModelRegistrations = vi.fn(function (this: IAgentRuntime) {
      expect(this).toBe(runtime);
      return [
        {
          modelType: ModelType.RESPONSE_HANDLER,
          provider: "fixture",
          priority: 100,
          registrationOrder: 0,
          metadata: {
            displayModel: "qwen-3.8-27b",
            contextWindowTokens: 64_000,
          },
        },
      ];
    });
    const runtime = {
      agentId: message.agentId,
      character: { name: "Test Agent", bio: "Test assistant." },
      actions: [
        {
          name: "READ_RECORD",
          description: "Read fixture record",
          contexts: ["general"],
          validate: async () => true,
          parameters: [],
          handler: read,
        },
      ],
      providers: [],
      getService: vi.fn(() => null),
      getRoom: vi.fn(async () => ({
        id: message.roomId,
        worldId: id("6"),
        type: ChannelType.DM,
      })),
      getWorld: vi.fn(async () => ({
        id: id("6"),
        agentId: message.agentId,
        metadata: {
          roles: { [message.entityId]: "OWNER" },
          roleSources: { [message.entityId]: "manual" },
        },
      })),
      getSetting,
      getModelRegistrations,
      supportsModelAttemptPreparation: true,
      composeState: vi.fn(async () => structuredClone(state)),
      runActionsByMode: vi.fn(async () => undefined),
      emitEvent: vi.fn(async () => undefined),
      reportError: vi.fn(),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
      },
      responseHandlerFieldRegistry: fields,
      responseHandlerFieldEvaluators: fields.list(),
      responseHandlerEvaluators: direct
        ? [
            {
              name: "fixture-direct",
              deterministicActions: ["READ_RECORD"],
              shouldRun: () => true,
              evaluate: () => ({
                requiresTool: true,
                clearReply: true,
                deterministicToolCall: { name: "READ_RECORD", params: {} },
              }),
            },
          ]
        : [],
      useModel: vi.fn(async (type: string, request: GenerateTextParams) => {
        calls.push({ type, model: request.model });
        if (type === ModelType.RESPONSE_HANDLER && handlerCalls++ === 0) {
          expect(request).not.toHaveProperty("model");
          return {
            text: "",
            toolCalls: [
              {
                id: "handler",
                name: "HANDLE_RESPONSE",
                arguments: {
                  shouldRespond: "RESPOND",
                  contexts: ["general"],
                  intents: ["Read the fixture record"],
                  candidateActionNames: ["READ_RECORD"],
                  contextRequests: [],
                  replyText: "",
                  replyEffectStatus: "pending",
                  facts: [],
                  relationships: [],
                  topics: [],
                  addressedTo: [],
                  emotion: "none",
                },
              },
            ],
          };
        }
        if (type === ModelType.ACTION_PLANNER) {
          expect(request).not.toHaveProperty("model");
          if (direct) {
            expect(read).toHaveBeenCalledTimes(1);
            // The settled synthesis must reach its completion evaluator.
            return JSON.stringify({
              completed: false,
              toolCalls: [],
              messageToUser: "",
            });
          }
          return {
            text: "",
            toolCalls: [
              {
                id: "read",
                name: "READ_RECORD",
                arguments: { eliza_turn_scope: "final" },
              },
            ],
          };
        }
        expect(type).toBe(ModelType.RESPONSE_HANDLER);
        evaluatorCalls++;
        expect(read).toHaveBeenCalledTimes(1);
        expect(request.model).toBe(
          setting === "unset" ? undefined : "gpt-oss-120b",
        );
        expect(request.providerOptions).toHaveProperty(
          "eliza.modelInputBudget.contextWindowTokens",
          setting === "unset" ? 64_000 : 128_000,
        );
        expect(getModelRegistrations).toHaveBeenCalled();
        expect(JSON.stringify(request.messages)).toContain("amber");
        return JSON.stringify({
          thought: "",
          success: true,
          decision: "FINISH",
          messageToUser: "The fixture record is amber.",
          replyEffectStatus: "none",
        });
      }),
    } as unknown as IAgentRuntime;
    const result = await runV5MessageRuntimeStage1({
      runtime,
      state,
      message,
      responseId: id("5"),
    });
    expect(result.kind).toBe("planned_reply");
    expect(evaluatorCalls).toBe(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([
      { type: ModelType.RESPONSE_HANDLER, model: undefined },
      { type: ModelType.ACTION_PLANNER, model: undefined },
      {
        type: ModelType.RESPONSE_HANDLER,
        model: setting === "unset" ? undefined : "gpt-oss-120b",
      },
    ]);
    expect(getSetting).toHaveBeenCalledWith("ELIZA_EVALUATOR_MODEL");
  },
);
