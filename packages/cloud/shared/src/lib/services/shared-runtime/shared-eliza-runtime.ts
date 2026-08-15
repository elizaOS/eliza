/**
 * Runs one Shared turn through the genuine Eliza message pipeline in Workerd.
 * Durable Object history remains authoritative; each turn projects that history
 * into an ephemeral runtime, invokes the canonical response handler, and returns
 * only the landed user/assistant pair for the caller's durable commit.
 */

import {
  AgentRuntime,
  ChannelType,
  createMessageMemory,
  type GenerateTextParams,
  type IAgentRuntime,
  InMemoryDatabaseAdapter,
  ModelType,
  type Plugin,
  stringToUuid,
  type ToolChoice,
  type ToolDefinition,
} from "@elizaos/core/edge";
import { createSharedRemindersEdgePlugin } from "@elizaos/plugin-scheduling/edge";
import { webSearchEdgeAction, webSearchEdgePlugin } from "@elizaos/plugin-web-search/edge";
import { generateText, type JSONSchema7, jsonSchema, type ModelMessage, type ToolSet } from "ai";
import { getInteractiveCerebrasLanguageModel } from "../../providers/language-model";
import type {
  RunSharedAgentTurnInput,
  RunSharedAgentTurnResult,
  SharedAgentTurnUsage,
  SharedTurnMessage,
} from "./run-shared-agent-turn";
import { appendSharedTurn } from "./run-shared-agent-turn";

type NativeTextModelResult = string & {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  finishReason: string;
  usage: SharedAgentTurnUsage;
  providerMetadata: { modelName: string };
};

function modelToolChoice(
  choice: ToolChoice | undefined,
): "auto" | "none" | "required" | { type: "tool"; toolName: string } | undefined {
  if (!choice || choice === "auto" || choice === "none" || choice === "required") {
    return choice;
  }
  if ("type" in choice && choice.type === "tool") {
    return { type: "tool", toolName: choice.name };
  }
  if ("type" in choice && choice.type === "function") {
    return { type: "tool", toolName: choice.function.name };
  }
  return { type: "tool", toolName: choice.name };
}

function modelTools(tools: ToolDefinition[] | undefined): ToolSet | undefined {
  if (!tools?.length) return undefined;
  return Object.fromEntries(
    tools.map((tool) => [
      tool.name,
      {
        ...(tool.description ? { description: tool.description } : {}),
        inputSchema: jsonSchema((tool.parameters ?? { type: "object" }) as JSONSchema7),
      },
    ]),
  );
}

function normalizeUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): SharedAgentTurnUsage {
  return {
    promptTokens: usage.inputTokens,
    completionTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
}

function addUsage(
  current: SharedAgentTurnUsage | undefined,
  next: SharedAgentTurnUsage,
): SharedAgentTurnUsage {
  const add = (left: number | undefined, right: number | undefined) =>
    left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
  return {
    promptTokens: add(current?.promptTokens, next.promptTokens),
    completionTokens: add(current?.completionTokens, next.completionTokens),
    totalTokens: add(current?.totalTokens, next.totalTokens),
    inputTokens: add(current?.inputTokens, next.inputTokens),
    outputTokens: add(current?.outputTokens, next.outputTokens),
  };
}

function runtimeMemoryId(message: SharedTurnMessage, index: number) {
  return stringToUuid(
    message.id ?? `${message.role}:${message.createdAt ?? index}:${message.content}`,
  );
}

export async function runSharedElizaRuntimeTurn(
  input: RunSharedAgentTurnInput & { agentKey: string; model: string },
): Promise<RunSharedAgentTurnResult> {
  const adapter = new InMemoryDatabaseAdapter();
  let providerDispatched = false;
  let usage: SharedAgentTurnUsage | undefined;
  const model = getInteractiveCerebrasLanguageModel(input.model);

  const modelHandler = async (
    _runtime: IAgentRuntime,
    params: GenerateTextParams,
  ): Promise<string | NativeTextModelResult> => {
    if (!providerDispatched) {
      providerDispatched = true;
      await input.onProviderDispatch?.();
    }
    const result = await generateText({
      model,
      maxRetries: 0,
      allowSystemInMessages: true,
      ...(params.messages
        ? { messages: params.messages as ModelMessage[] }
        : { prompt: params.prompt ?? "" }),
      ...(params.tools ? { tools: modelTools(params.tools) } : {}),
      ...(params.toolChoice ? { toolChoice: modelToolChoice(params.toolChoice) } : {}),
      ...(typeof params.maxTokens === "number" ? { maxOutputTokens: params.maxTokens } : {}),
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
      ...(typeof params.topP === "number" ? { topP: params.topP } : {}),
      ...(params.signal ? { abortSignal: params.signal } : {}),
    });
    usage = addUsage(usage, normalizeUsage(result.usage));
    if (result.toolCalls.length === 0) {
      return result.text;
    }
    return {
      text: result.text,
      toolCalls: result.toolCalls.map((call) => ({
        id: call.toolCallId,
        name: call.toolName,
        arguments: call.input,
      })),
      finishReason: result.finishReason,
      usage,
      providerMetadata: { modelName: input.model },
    } as NativeTextModelResult;
  };

  const modelPlugin: Plugin = {
    name: "shared-cerebras-model",
    description: "Platform-funded text generation for the Shared Workerd runtime.",
    models: {
      [ModelType.RESPONSE_HANDLER]: modelHandler,
      [ModelType.ACTION_PLANNER]: modelHandler,
      [ModelType.TEXT_SMALL]: modelHandler,
      [ModelType.TEXT_LARGE]: modelHandler,
    },
  };
  const reminderPlugin = input.execution?.reminders
    ? createSharedRemindersEdgePlugin({
        runner: input.execution.reminders.runner,
        agentId: input.agentKey,
        delivery: input.execution.reminders.delivery,
      })
    : undefined;
  const runtime = new AgentRuntime({
    agentId: stringToUuid(input.agentKey),
    character: {
      name: input.character.name,
      system: input.character.system,
      bio: input.character.bio ?? [],
      plugins: [],
      settings: {
        ELIZA_CANONICAL_LLM_TEXT_ENABLED: true,
        ELIZA_CANONICAL_EMBEDDINGS_ENABLED: false,
      },
    },
    adapter,
    plugins: [modelPlugin, webSearchEdgePlugin, ...(reminderPlugin ? [reminderPlugin] : [])],
    logLevel: "error",
    actionPlanning: true,
    checkShouldRespond: false,
    enableAutonomy: false,
    enableDocuments: false,
    enableRelationships: false,
    enableTrajectories: false,
  });

  try {
    await runtime.initialize({ skipMigrations: true });
    if (!runtime.actions.some((action) => action.name === webSearchEdgeAction.name)) {
      throw new Error("Eliza Shared runtime initialized without its WEB_SEARCH action");
    }
    if (
      input.execution?.reminders &&
      !runtime.actions.some((action) => action.name === "REMINDERS")
    ) {
      throw new Error("Eliza Shared runtime initialized without its REMINDERS action");
    }
    const entityId = stringToUuid(`${input.agentKey}:owner`);
    const roomId = stringToUuid(`${input.agentKey}:conversation`);
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId: stringToUuid(`${input.agentKey}:world`),
      userName: "Shared user",
      source: "shared-runtime",
      type: ChannelType.DM,
    });
    if (input.history.length > 0) {
      await adapter.createMemories(
        input.history.map((message, index) => ({
          tableName: "messages",
          memory: createMessageMemory({
            id: runtimeMemoryId(message, index),
            entityId: message.role === "assistant" ? runtime.agentId : entityId,
            agentId: runtime.agentId,
            roomId,
            content: {
              text: message.content,
              source: "shared-runtime",
              channelType: ChannelType.DM,
            },
          }),
        })),
      );
    }

    const delivered: string[] = [];
    const messageService = runtime.messageService;
    if (!messageService) {
      throw new Error("Eliza Shared runtime initialized without a message service");
    }
    const result = await messageService.handleMessage(
      runtime,
      createMessageMemory({
        id: stringToUuid(input.messageIds?.user ?? `${input.agentKey}:${input.message}`),
        entityId,
        agentId: runtime.agentId,
        roomId,
        content: {
          text: input.message.trim(),
          source: "shared-runtime",
          channelType: ChannelType.DM,
        },
      }),
      async (content) => {
        if (content.text?.trim()) delivered.push(content.text.trim());
        return [];
      },
      input.abortSignal ? { abortSignal: input.abortSignal } : undefined,
    );
    const reply = result?.responseContent?.text?.trim() || delivered.at(-1)?.trim() || "";
    if (!result?.didRespond || !reply) {
      throw new Error("Eliza Shared runtime completed without a user-visible reply");
    }
    return {
      reply,
      history: appendSharedTurn(
        input.history,
        input.message.trim(),
        reply,
        input.messageIds,
        input.messageRole,
      ),
      model: input.model,
      degraded: false,
      usage,
    };
  } finally {
    await runtime.stop();
    await runtime.close();
  }
}
