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
  type StreamingContext,
  setStreamingContextManager,
  stringToUuid,
  type TextStreamResult,
  type ToolChoice,
  type ToolDefinition,
} from "@elizaos/core/edge";
import { createSharedRemindersEdgePlugin } from "@elizaos/plugin-scheduling/edge";
import { webSearchEdgeAction, webSearchEdgePlugin } from "@elizaos/plugin-web-search/edge";
import {
  generateText,
  type JSONSchema7,
  jsonSchema,
  type ModelMessage,
  streamText,
  type ToolSet,
} from "ai";
import { getInteractiveCerebrasLanguageModel } from "../../providers/language-model";
import { logger } from "../../utils/logger";
import type {
  RunSharedAgentTurnInput,
  RunSharedAgentTurnResult,
  RunSharedAgentTurnStreamResult,
  SharedAgentTurnStreamPart,
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

let edgeStreamingContextReady: Promise<void> | undefined;
let sharedRuntimeKernelReady: Promise<AgentRuntime> | undefined;

async function ensureEdgeStreamingContext(): Promise<void> {
  edgeStreamingContextReady ??= import("node:async_hooks").then(({ AsyncLocalStorage }) => {
    const storage = new AsyncLocalStorage<StreamingContext | undefined>();
    setStreamingContextManager({
      run: <T>(context: StreamingContext | undefined, fn: () => T): T => storage.run(context, fn),
      active: () => storage.getStore(),
    });
  });
  await edgeStreamingContextReady;
}

function prewarmModelHandler(): never {
  throw new Error("Shared runtime prewarm must not dispatch inference");
}

function sharedModelPlugin(
  handler: (
    runtime: IAgentRuntime,
    params: GenerateTextParams,
  ) => Promise<string | NativeTextModelResult | TextStreamResult>,
): Plugin {
  return {
    name: "shared-cerebras-model",
    description: "Platform-funded text generation for the Shared Workerd runtime.",
    models: {
      [ModelType.RESPONSE_HANDLER]: handler,
      [ModelType.ACTION_PLANNER]: handler,
      [ModelType.TEXT_SMALL]: handler,
      [ModelType.TEXT_LARGE]: handler,
    },
    modelMetadata: {
      [ModelType.RESPONSE_HANDLER]: { streamable: true },
      [ModelType.ACTION_PLANNER]: { streamable: true },
      [ModelType.TEXT_SMALL]: { streamable: true },
      [ModelType.TEXT_LARGE]: { streamable: true },
    },
  };
}

function createRuntime(options: {
  agentKey: string;
  adapter: InMemoryDatabaseAdapter;
  character: RunSharedAgentTurnInput["character"];
  modelPlugin: Plugin;
  reminderPlugin?: Plugin;
}): AgentRuntime {
  return new AgentRuntime({
    agentId: stringToUuid(options.agentKey),
    character: {
      name: options.character.name,
      system: options.character.system,
      bio: options.character.bio ?? [],
      plugins: [],
      settings: {
        ELIZA_CANONICAL_LLM_TEXT_ENABLED: true,
        ELIZA_CANONICAL_EMBEDDINGS_ENABLED: false,
      },
    },
    adapter: options.adapter,
    plugins: [
      options.modelPlugin,
      webSearchEdgePlugin,
      ...(options.reminderPlugin ? [options.reminderPlugin] : []),
    ],
    logLevel: "error",
    actionPlanning: true,
    checkShouldRespond: false,
    enableAutonomy: false,
    enableDocuments: false,
    enableRelationships: false,
    enableTrajectories: false,
  });
}

/** Pays one-time Workerd runtime initialization before the first live user turn. */
export async function prewarmSharedElizaRuntime(): Promise<void> {
  await ensureEdgeStreamingContext();
  sharedRuntimeKernelReady ??= (async () => {
    const runtime = createRuntime({
      agentKey: "shared-runtime-kernel-prewarm",
      adapter: new InMemoryDatabaseAdapter(),
      character: {
        name: "Shared Eliza",
        system: "Shared runtime initialization prewarm.",
      },
      modelPlugin: sharedModelPlugin(async () => prewarmModelHandler()),
    });
    try {
      await runtime.initialize({ skipMigrations: true });
      if (!runtime.actions.some((action) => action.name === webSearchEdgeAction.name)) {
        throw new Error("Eliza Shared runtime prewarm omitted its WEB_SEARCH action");
      }
      // Retain this state-free runtime for the isolate lifetime. Several core
      // services finish their asynchronous start just after initialize();
      // stopping immediately races those starts, while waiting on optional
      // service names adds their full load timeout to every cold phone call.
      return runtime;
    } catch (error) {
      try {
        await runtime.stop();
      } catch (teardownError) {
        // error-policy:J6 failed prewarm owns this disposable runtime, so its
        // teardown cannot replace the initialization failure reported upstream.
        logger.warn("[shared-eliza-runtime] failed prewarm stop failed", {
          error: teardownError instanceof Error ? teardownError.message : String(teardownError),
        });
      }
      try {
        await runtime.close();
      } catch (teardownError) {
        // error-policy:J6 failed prewarm owns this disposable runtime, so its
        // teardown cannot replace the initialization failure reported upstream.
        logger.warn("[shared-eliza-runtime] failed prewarm close failed", {
          error: teardownError instanceof Error ? teardownError.message : String(teardownError),
        });
      }
      throw error;
    }
  })().catch((error) => {
    sharedRuntimeKernelReady = undefined;
    throw error;
  });
  await sharedRuntimeKernelReady;
}

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

async function executeSharedElizaRuntimeTurn(
  input: RunSharedAgentTurnInput & { agentKey: string; model: string },
  onStreamChunk?: (chunk: string) => void | Promise<void>,
): Promise<RunSharedAgentTurnResult> {
  await ensureEdgeStreamingContext();
  const adapter = new InMemoryDatabaseAdapter();
  let providerDispatched = false;
  let usage: SharedAgentTurnUsage | undefined;
  const model = getInteractiveCerebrasLanguageModel(input.model);

  const modelHandler = async (
    _runtime: IAgentRuntime,
    params: GenerateTextParams,
  ): Promise<string | NativeTextModelResult | TextStreamResult> => {
    if (!providerDispatched) {
      providerDispatched = true;
      await input.onProviderDispatch?.();
    }
    const generation = {
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
    };
    if (onStreamChunk && params.stream === true) {
      const result = streamText(generation);
      const textStream = (async function* (): AsyncIterable<string> {
        if (params.streamStructured === true) {
          for await (const part of result.fullStream) {
            const record = part as {
              type: string;
              delta?: string;
              inputTextDelta?: string;
            };
            const chunk =
              record.type === "tool-input-delta"
                ? (record.inputTextDelta ?? record.delta)
                : undefined;
            if (chunk) yield chunk;
          }
          return;
        }
        for await (const chunk of result.textStream) yield chunk;
      })();
      const streamUsage = Promise.resolve(result.totalUsage).then((value) => {
        const normalized = normalizeUsage(value);
        usage = addUsage(usage, normalized);
        return normalized;
      });
      return {
        textStream,
        text: Promise.resolve(result.text),
        toolCalls: Promise.resolve(result.toolCalls).then((calls) =>
          calls.map((call) => ({
            id: call.toolCallId,
            name: call.toolName,
            arguments: call.input,
          })),
        ),
        finishReason: Promise.resolve(result.finishReason),
        usage: streamUsage,
        providerMetadata: { modelName: input.model },
      } as TextStreamResult;
    }
    const result = await generateText({
      ...generation,
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

  const modelPlugin = sharedModelPlugin(modelHandler);
  const reminderPlugin = input.execution?.reminders
    ? createSharedRemindersEdgePlugin({
        runner: input.execution.reminders.runner,
        agentId: input.agentKey,
        delivery: input.execution.reminders.delivery,
      })
    : undefined;
  const runtime = createRuntime({
    agentKey: input.agentKey,
    adapter,
    character: input.character,
    modelPlugin,
    reminderPlugin,
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
      input.abortSignal || onStreamChunk
        ? {
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            ...(onStreamChunk ? { onStreamChunk } : {}),
          }
        : undefined,
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

export async function runSharedElizaRuntimeTurn(
  input: RunSharedAgentTurnInput & { agentKey: string; model: string },
): Promise<RunSharedAgentTurnResult> {
  return await executeSharedElizaRuntimeTurn(input);
}

function isRuntimeControlChunk(chunk: string): boolean {
  if (!chunk.startsWith("{")) return false;
  try {
    const value = JSON.parse(chunk) as { type?: unknown };
    return (
      value.type === "tool_call" ||
      value.type === "tool_result" ||
      value.type === "evaluation" ||
      value.type === "context_event"
    );
  } catch {
    // A partial structured reply is visible text, not a complete control event.
    return false;
  }
}

export async function runSharedElizaRuntimeTurnStream(
  input: RunSharedAgentTurnInput & { agentKey: string; model: string },
): Promise<RunSharedAgentTurnStreamResult> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(input.abortSignal?.reason);
  if (input.abortSignal?.aborted) abortFromCaller();
  else input.abortSignal?.addEventListener("abort", abortFromCaller, { once: true });

  const queued: SharedAgentTurnStreamPart[] = [];
  let wake: (() => void) | undefined;
  let terminalError: unknown;
  let terminal = false;
  let emittedText = "";
  const signalQueue = () => {
    wake?.();
    wake = undefined;
  };
  const push = (part: SharedAgentTurnStreamPart) => {
    if (terminal) return;
    queued.push(part);
    signalQueue();
  };

  const completion = executeSharedElizaRuntimeTurn(
    { ...input, abortSignal: controller.signal },
    async (chunk) => {
      if (!controller.signal.aborted && !isRuntimeControlChunk(chunk)) {
        emittedText += chunk;
        push({ type: "text-delta", text: chunk });
      }
    },
  )
    .then((result) => {
      if (!controller.signal.aborted) {
        if (!result.reply.startsWith(emittedText)) {
          throw new Error("Eliza Shared runtime reply diverged from streamed text");
        }
        const remainingText = result.reply.slice(emittedText.length);
        if (remainingText) push({ type: "text-delta", text: remainingText });
      }
      push({ type: "finish", text: result.reply, usage: result.usage });
      terminal = true;
      signalQueue();
    })
    .catch((error) => {
      terminalError = error;
      terminal = true;
      signalQueue();
    })
    .finally(() => {
      input.abortSignal?.removeEventListener("abort", abortFromCaller);
    });

  const parts = (async function* (): AsyncIterable<SharedAgentTurnStreamPart> {
    for (;;) {
      while (queued.length > 0) {
        const next = queued.shift();
        if (next) yield next;
      }
      if (terminal) {
        if (terminalError) throw terminalError;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();

  return {
    model: input.model,
    degraded: false,
    parts,
    cancel: async (reason) => {
      controller.abort(reason);
      void completion;
    },
  };
}
