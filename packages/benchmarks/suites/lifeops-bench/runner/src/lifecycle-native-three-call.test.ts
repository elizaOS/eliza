/**
 * Exercises the lifecycle TASKS turn through the native v5 message pipeline and
 * Claude-subscription response adapter. The deterministic provider reproduces
 * the structured completion-evaluator shape that previously failed parsing.
 */
import {
  type Action,
  BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
  type GenerateTextParams,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type Plugin,
  ResponseHandlerFieldRegistry,
  recordLlmCall,
  runV5MessageRuntimeStage1,
  runWithLlmInputSubstringAttestation,
  type State,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  LIFECYCLE_TASKS_TOOL_CONTRACT,
  lifecycleCaptureOnlyTasksAction,
  projectLifecycleTaskExecutions,
  runWithLifecycleTaskCapture,
} from "./lifecycle-task-action";
import {
  claudeSubscriptionChatOnlyPlugin,
  LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME,
} from "./subscription-chat-capabilities";

const MESSAGE_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const SENDER_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const AGENT_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000004" as UUID;
const RESPONSE_ID = "00000000-0000-0000-0000-000000000005" as UUID;

async function* emptyTextStream(): AsyncGenerator<string> {
  yield* [];
}

function structuredToolResult(toolCalls: unknown) {
  return {
    textStream: emptyTextStream(),
    text: Promise.resolve(""),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve("tool_calls"),
    toolCalls,
  };
}

function recordNativeProviderCall<T>(
  modelType: string,
  params: GenerateTextParams,
  provider: () => Promise<T> | T,
): Promise<T> {
  return recordLlmCall(
    null,
    {
      model: "fixture-subscription-model",
      modelType,
      provider: "fixture-subscription-gateway",
      systemPrompt: typeof params.system === "string" ? params.system : "",
      userPrompt: typeof params.prompt === "string" ? params.prompt : "",
      messages: params.messages,
      tools: params.tools,
      toolChoice: params.toolChoice,
      temperature: params.temperature ?? 0,
      maxTokens: params.maxTokens ?? 1024,
      purpose: "external_llm",
      actionType: "fixture.subscription.generate",
    },
    provider,
  );
}

function sourcePlugin(
  responseHandler: (
    runtime: IAgentRuntime,
    params: GenerateTextParams,
  ) => Promise<unknown>,
  actionPlanner: (
    runtime: IAgentRuntime,
    params: GenerateTextParams,
  ) => Promise<unknown>,
): Plugin {
  return {
    name: "openai",
    description: "Deterministic OpenAI-compatible lifecycle provider.",
    models: {
      [ModelType.TEXT_TOKENIZER_ENCODE]: async () => [1, 2, 3],
      [ModelType.TEXT_TOKENIZER_DECODE]: async () => "decoded",
      [ModelType.TEXT_NANO]: async () => "nano",
      [ModelType.TEXT_SMALL]: async () => "small",
      [ModelType.TEXT_MEDIUM]: async () => "medium",
      [ModelType.TEXT_LARGE]: async () => "large",
      [ModelType.TEXT_MEGA]: async () => "mega",
      [ModelType.RESPONSE_HANDLER]: responseHandler,
      [ModelType.ACTION_PLANNER]: actionPlanner,
    },
  } as Plugin;
}

function tasksAction(): Action {
  return lifecycleCaptureOnlyTasksAction({
    name: "TASKS",
    description: "Production task action.",
    validate: async () => false,
    handler: async () => ({ success: false }),
  });
}

describe("native lifecycle three-call graph", () => {
  it("completes HANDLE_RESPONSE -> TASKS -> HANDLE_RESPONSE without a V5 structured parse gap", async () => {
    const lifecycleHint = "Exact shared lifecycle system instruction.";
    const responseHandler = vi
      .fn<
        (runtime: IAgentRuntime, params: GenerateTextParams) => Promise<unknown>
      >()
      .mockImplementationOnce((_runtime, params) =>
        recordNativeProviderCall(
          ModelType.RESPONSE_HANDLER,
          params,
          async () => {
            expect(params.responseSchema).toBeUndefined();
            expect(params.toolChoice).toBe("required");
            expect(params.tools?.map((tool) => tool.name)).toEqual([
              "HANDLE_RESPONSE",
            ]);
            return {
              text: "",
              toolCalls: [
                {
                  id: "call_stage_1",
                  name: "HANDLE_RESPONSE",
                  arguments: {
                    shouldRespond: "RESPOND",
                    contexts: ["general"],
                    intents: ["delegate lifecycle task"],
                    replyText: "I will handle that.",
                    candidateActionNames: ["TASKS"],
                    facts: [],
                    relationships: [],
                    topics: [],
                    addressedTo: [],
                    emotion: "none",
                  },
                },
              ],
            };
          },
        ),
      )
      .mockImplementationOnce((_runtime, params) =>
        recordNativeProviderCall(
          ModelType.RESPONSE_HANDLER,
          params,
          async () => {
            // The adapter replaces responseSchema with one forced native tool, so
            // the provider never enters the object-generation path that raised
            // AI_NoObjectGeneratedError in the historical canary.
            expect(params.responseSchema).toBeUndefined();
            expect(params.toolChoice).toBe("required");
            expect(params.tools?.map((tool) => tool.name)).toEqual([
              LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME,
            ]);
            return structuredToolResult([
              {
                id: "call_completion_evaluator",
                name: LIFECYCLE_STRUCTURED_RESPONSE_TOOL_NAME,
                arguments: {
                  success: true,
                  decision: "FINISH",
                  thought: "The capture-only TASKS action completed.",
                  messageToUser: "The lifecycle task was captured.",
                },
              },
            ]);
          },
        ),
      );
    const actionPlanner = vi.fn(
      (_runtime: IAgentRuntime, params: GenerateTextParams) =>
        recordNativeProviderCall(ModelType.ACTION_PLANNER, params, async () => {
          const taskTool = params.tools?.find((tool) => tool.name === "TASKS");
          expect(taskTool?.parameters).toEqual(
            LIFECYCLE_TASKS_TOOL_CONTRACT.function.parameters,
          );
          expect(taskTool?.strict).toBe(false);
          return {
            text: "Capturing the lifecycle request.",
            toolCalls: [
              {
                id: "call_tasks",
                name: "TASKS",
                args: { action: "spawn_agent", task: "inspect benchmark" },
              },
            ],
          };
        }),
    );
    const restricted = claudeSubscriptionChatOnlyPlugin(
      sourcePlugin(responseHandler, actionPlanner),
      {
        lifecycleStructuredResponseTool: true,
        lifecycleTasksToolSchema:
          LIFECYCLE_TASKS_TOOL_CONTRACT.function.parameters,
      },
    );
    const responseModel = restricted.models?.[ModelType.RESPONSE_HANDLER];
    const plannerModel = restricted.models?.[ModelType.ACTION_PLANNER];
    if (!responseModel || !plannerModel) {
      throw new Error("Lifecycle subscription models were not installed");
    }

    const responseHandlerFieldRegistry = new ResponseHandlerFieldRegistry();
    for (const evaluator of BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS) {
      responseHandlerFieldRegistry.register(evaluator);
    }
    const modelTypes: string[] = [];
    let runtime: IAgentRuntime;
    runtime = {
      agentId: AGENT_ID,
      character: {
        name: "Lifecycle Test Agent",
        system: lifecycleHint,
        bio: "I capture benchmark lifecycle requests.",
      },
      actions: [tasksAction()],
      providers: [],
      responseHandlerFieldRegistry,
      responseHandlerFieldEvaluators: [
        ...BUILTIN_RESPONSE_HANDLER_FIELD_EVALUATORS,
      ],
      emitEvent: vi.fn(async () => undefined),
      runActionsByMode: vi.fn(async () => undefined),
      useModel: vi.fn(async (modelType, params) => {
        modelTypes.push(String(modelType));
        if (modelType === ModelType.RESPONSE_HANDLER) {
          return responseModel(runtime, params);
        }
        if (modelType === ModelType.ACTION_PLANNER) {
          return plannerModel(runtime, params);
        }
        throw new Error(`Unexpected lifecycle model call ${String(modelType)}`);
      }),
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
      },
    } as unknown as IAgentRuntime;
    const message: Memory = {
      id: MESSAGE_ID,
      entityId: SENDER_ID,
      agentId: AGENT_ID,
      roomId: ROOM_ID,
      content: {
        text: "Delegate this lifecycle benchmark task.",
        source: "benchmark",
      },
      createdAt: 1,
    };
    const state: State = {
      values: {
        availableContexts:
          "general, code, automation, agent_internal, connectors",
      },
      data: {},
      text: "Lifecycle benchmark turn.",
    };

    const dispatch = await runWithLlmInputSubstringAttestation(
      lifecycleHint,
      () =>
        runWithLifecycleTaskCapture(() =>
          runV5MessageRuntimeStage1({
            runtime,
            message,
            state,
            responseId: RESPONSE_ID,
          }),
        ),
    );
    const turn = dispatch.result;

    expect(modelTypes).toEqual([
      ModelType.RESPONSE_HANDLER,
      ModelType.ACTION_PLANNER,
      ModelType.RESPONSE_HANDLER,
    ]);
    expect(dispatch.attestation).toMatchObject({
      modelCallCount: 3,
      matchingCallCount: 3,
      totalOccurrences: 3,
      exactOncePerModelCall: true,
      modelTypeCallCounts: {
        ACTION_PLANNER: 1,
        RESPONSE_HANDLER: 2,
      },
    });
    expect(JSON.stringify(dispatch.attestation)).not.toContain(lifecycleHint);
    expect(responseHandler).toHaveBeenCalledTimes(2);
    expect(actionPlanner).toHaveBeenCalledTimes(1);
    expect(turn.executions).toHaveLength(1);
    expect(turn.result.kind).toBe("planned_reply");
    if (turn.result.kind !== "planned_reply") {
      throw new Error(`Expected planned_reply, received ${turn.result.kind}`);
    }
    const projection = projectLifecycleTaskExecutions(
      turn.executions,
      turn.result.result.actionResults,
    );
    expect(projection.toolCalls).toEqual([
      {
        id: "call_lifecycle_0",
        name: "TASKS",
        arguments: { action: "spawn_agent", task: "inspect benchmark" },
      },
    ]);
    expect(turn.result.result.responseContent?.text).toBe(
      "The lifecycle task was captured.",
    );
  });
});
