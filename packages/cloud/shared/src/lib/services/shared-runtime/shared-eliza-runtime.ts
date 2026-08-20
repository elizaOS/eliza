/**
 * Runs one Shared turn through the genuine Eliza message pipeline in Workerd.
 * Durable Object history remains authoritative; each turn projects that history
 * into an ephemeral runtime, invokes the canonical response handler, and returns
 * only the landed user/assistant pair for the caller's durable commit.
 */

import {
  type AgentEventPayload,
  AgentEventService,
  type AgentNotification,
  AgentRuntime,
  basicProviders,
  basicServices,
  CONTEXT_ROUTING_METADATA_KEY,
  createMessageMemory,
  ElizaError,
  type GenerateTextParams,
  generateMediaAction,
  type IAgentRuntime,
  IMediaGenerationService,
  type InferenceTurnSummary,
  InMemoryDatabaseAdapter,
  type MediaGenerationRequest,
  type Memory,
  ModelType,
  NOTIFICATION_STREAM,
  NotificationService,
  type Plugin,
  ServiceType,
  type StreamingContext,
  setStreamingContextManager,
  stringToUuid,
  type TextStreamResult,
  type ToolChoice,
  type ToolDefinition,
  type UUID,
} from "@elizaos/core/edge";
import { createSharedRemindersEdgePlugin } from "@elizaos/plugin-scheduling/edge";
import { createTodosEdgePlugin } from "@elizaos/plugin-todos/edge";
import { webSearchEdgeAction, webSearchEdgePlugin } from "@elizaos/plugin-web-search/edge";
import type { AgentCapabilityTransport } from "@elizaos/shared";
import {
  generateText,
  type JSONSchema7,
  jsonSchema,
  type ModelMessage,
  streamText,
  type ToolSet,
} from "ai";
import type { MobilePushMessage } from "../../mobile-push/types";
import { getInteractiveCerebrasLanguageModel } from "../../providers/language-model";
import { logger } from "../../utils/logger";
import type {
  RunSharedAgentTurnInput,
  RunSharedAgentTurnResult,
  RunSharedAgentTurnStreamResult,
  SharedAgentTurnStreamPart,
  SharedAgentTurnUsage,
  SharedMediaGenerationPort,
  SharedTurnMessage,
} from "./run-shared-agent-turn";
import { appendSharedInput, appendSharedTurn } from "./run-shared-agent-turn";
import { sharedCapabilityTransportForSource } from "./shared-capability-catalog";
import {
  createSharedRuntimeCapabilitiesPlugin,
  REQUEST_DEDICATED_UPGRADE_ACTION,
  SHARED_RUNTIME_CAPABILITIES_PROVIDER,
} from "./shared-runtime-capabilities";
import {
  sharedRuntimeConversationRoomId,
  sharedRuntimeWorldId,
} from "./shared-runtime-storage-identity";
import {
  SharedRuntimeTimingCollector,
  type SharedRuntimeTimingOutcome,
  type SharedRuntimeTimingReceipt,
} from "./shared-runtime-timing";
import { SHARED_TURN_MAX_RETRIES } from "./shared-turn-retry-budget";

type NativeTextModelResult = string & {
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: unknown }>;
  finishReason: string;
  usage: SharedAgentTurnUsage;
  providerMetadata: { modelName: string };
};

type SharedElizaRuntimeTurnInput = Omit<RunSharedAgentTurnInput, "execution"> & {
  execution: NonNullable<RunSharedAgentTurnInput["execution"]>;
  agentKey: string;
  model: string;
};

interface SharedNotificationEventBus {
  subscribe(listener: (event: AgentEventPayload) => void): () => void;
}

type SharedMobilePushDispatch = (message: MobilePushMessage) => Promise<void>;

function isSharedNotificationEventBus(value: unknown): value is SharedNotificationEventBus {
  return Boolean(
    value &&
      typeof value === "object" &&
      "subscribe" in value &&
      typeof value.subscribe === "function",
  );
}

function notificationFromEvent(event: AgentEventPayload): AgentNotification | null {
  const notification = event.data?.notification;
  if (
    event.stream !== NOTIFICATION_STREAM ||
    !notification ||
    typeof notification !== "object" ||
    typeof (notification as AgentNotification).id !== "string" ||
    typeof (notification as AgentNotification).title !== "string"
  ) {
    return null;
  }
  return notification as AgentNotification;
}

/** Bridges canonical notification events to the hosting authority's push sender. */
export function subscribeSharedMobilePush(
  eventBus: SharedNotificationEventBus,
  dispatch: SharedMobilePushDispatch,
  pending: Promise<void>[],
): () => void {
  return eventBus.subscribe((event) => {
    const notification = notificationFromEvent(event);
    if (!notification) return;
    const data: Record<string, string | number | boolean | null> = {
      notificationId: notification.id,
      category: notification.category,
    };
    if (notification.deepLink) data.deepLink = notification.deepLink;
    if (notification.groupKey) data.groupKey = notification.groupKey;
    pending.push(
      dispatch({
        title: notification.title,
        body: notification.body,
        collapseKey: notification.id,
        data,
      }),
    );
  });
}

let edgeStreamingContextReady: Promise<void> | undefined;
let sharedRuntimeKernelReady: Promise<void> | undefined;

/** Canonical notification services required by the ephemeral Shared runtime. */
export const SHARED_NOTIFICATION_SERVICES = [AgentEventService, NotificationService] as const;

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
    services: [...SHARED_NOTIFICATION_SERVICES],
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

function sharedMediaPlugin(media: SharedMediaGenerationPort): Plugin {
  class SharedMediaGenerationService extends IMediaGenerationService {
    static override readonly serviceType = ServiceType.MEDIA_GENERATION;

    static override async start(runtime: IAgentRuntime): Promise<SharedMediaGenerationService> {
      return new SharedMediaGenerationService(runtime);
    }

    override canGenerateMedia(
      request: Pick<MediaGenerationRequest, "mediaType" | "audioKind">,
    ): boolean | Promise<boolean> {
      return media.canGenerateMedia(request);
    }

    override async generateMedia(request: MediaGenerationRequest) {
      return await media.generateMedia(request);
    }

    override async stop(): Promise<void> {}
  }

  return {
    name: "shared-cloud-media",
    description: "Server-authenticated Cloud media generation for the Shared Workerd runtime.",
    actions: [generateMediaAction],
    services: [SharedMediaGenerationService],
  };
}

const sharedSystemLifecyclePlugin: Plugin = {
  name: "shared-system-lifecycle",
  description: "Action-free message lifecycle plumbing for server-authenticated system turns.",
  providers: basicProviders,
  services: basicServices,
};

function createRuntime(options: {
  agentKey: string;
  agentId?: UUID;
  actionsEnabled: boolean;
  adapter: InMemoryDatabaseAdapter;
  character: RunSharedAgentTurnInput["character"];
  modelPlugin: Plugin;
  transport?: AgentCapabilityTransport;
  mediaPlugin?: Plugin;
  reminderPlugin?: Plugin;
  todoPlugin?: Plugin;
}): AgentRuntime {
  const capabilityPlugin = createSharedRuntimeCapabilitiesPlugin({
    agentId: options.agentKey,
    webSearch: options.actionsEnabled,
    reminders: options.actionsEnabled && Boolean(options.reminderPlugin),
    todos: options.actionsEnabled && Boolean(options.todoPlugin),
    media: options.actionsEnabled && Boolean(options.mediaPlugin),
    transport: options.transport,
  });
  return new AgentRuntime({
    agentId: options.agentId ?? stringToUuid(options.agentKey),
    character: {
      name: options.character.name,
      system: options.character.system,
      bio: options.character.bio ?? [],
      messageExamples: options.character.messageExamples ?? [],
      postExamples: options.character.postExamples ?? [],
      topics: options.character.topics ?? [],
      adjectives: options.character.adjectives ?? [],
      style: options.character.style,
      templates: options.character.templates,
      plugins: [],
      settings: {
        ELIZA_CANONICAL_LLM_TEXT_ENABLED: true,
        ELIZA_CANONICAL_EMBEDDINGS_ENABLED: false,
      },
    },
    adapter: options.adapter,
    plugins: [
      options.modelPlugin,
      ...(!options.actionsEnabled ? [sharedSystemLifecyclePlugin] : []),
      ...(options.actionsEnabled ? [capabilityPlugin] : []),
      ...(options.actionsEnabled ? [webSearchEdgePlugin] : []),
      ...(options.actionsEnabled && options.mediaPlugin ? [options.mediaPlugin] : []),
      ...(options.actionsEnabled && options.reminderPlugin ? [options.reminderPlugin] : []),
      ...(options.actionsEnabled && options.todoPlugin ? [options.todoPlugin] : []),
    ],
    logLevel: "error",
    disableBasicCapabilities: !options.actionsEnabled,
    actionPlanning: options.actionsEnabled,
    checkShouldRespond: true,
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
      actionsEnabled: true,
      adapter: new InMemoryDatabaseAdapter(),
      character: {
        name: "Shared Eliza",
        system: "Shared runtime initialization prewarm.",
      },
      modelPlugin: sharedModelPlugin(async () => prewarmModelHandler()),
    });
    let initializationError: unknown;
    try {
      await runtime.initialize({ skipMigrations: true });
      await Promise.allSettled(
        runtime
          .getRegisteredServiceTypes()
          .map((serviceType) => runtime.getServiceLoadPromise(serviceType)),
      );
      if (!runtime.actions.some((action) => action.name === webSearchEdgeAction.name)) {
        throw new Error("Eliza Shared runtime prewarm omitted its WEB_SEARCH action");
      }
    } catch (error) {
      initializationError = error;
    }

    const cleanupErrors: unknown[] = [];
    try {
      await runtime.stop();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await runtime.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (initializationError !== undefined) {
      for (const teardownError of cleanupErrors) {
        // error-policy:J6 failed prewarm owns this disposable runtime, so its
        // teardown cannot replace the initialization failure reported upstream.
        logger.warn("[shared-eliza-runtime] failed prewarm cleanup failed", {
          error: teardownError instanceof Error ? teardownError.message : String(teardownError),
        });
      }
      throw initializationError;
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "Shared runtime prewarm cleanup failed");
    }
    logger.info("[shared-eliza-runtime] prewarm runtime released");
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

function projectedHistoryTimestamps(history: SharedTurnMessage[]): number[] {
  const anchors: Array<{ index: number; timestamp: number }> = [];
  for (const [index, message] of history.entries()) {
    const timestamp = message.createdAt;
    if (
      typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      timestamp > 0 &&
      (anchors.length === 0 || timestamp > anchors[anchors.length - 1].timestamp)
    ) {
      anchors.push({ index, timestamp });
    }
  }
  if (anchors.length === 0) {
    const epoch = Date.now() - 5 * 60_000 - history.length;
    return history.map((_, index) => epoch + index);
  }

  const timestamps = new Array<number>(history.length);
  for (const anchor of anchors) timestamps[anchor.index] = anchor.timestamp;
  const first = anchors[0];
  for (let index = 0; index < first.index; index += 1) {
    timestamps[index] = first.timestamp - (first.index - index);
  }
  for (let anchorIndex = 0; anchorIndex < anchors.length - 1; anchorIndex += 1) {
    const left = anchors[anchorIndex];
    const right = anchors[anchorIndex + 1];
    const span = right.index - left.index;
    for (let index = left.index + 1; index < right.index; index += 1) {
      timestamps[index] =
        left.timestamp + ((right.timestamp - left.timestamp) * (index - left.index)) / span;
    }
  }
  const last = anchors.at(-1)!;
  for (let index = last.index + 1; index < history.length; index += 1) {
    timestamps[index] = last.timestamp + (index - last.index);
  }
  return timestamps;
}

function logSharedProviderSpans(
  input: SharedElizaRuntimeTurnInput,
  summary: InferenceTurnSummary | undefined,
  responded: boolean,
): void {
  const providerSpans = (summary?.spans ?? [])
    .filter((span) => span.name === "composeState" || span.name.startsWith("provider:"))
    .map((span) => ({ name: span.name, durationMs: span.durationMs }));
  const slowProviderSpans = providerSpans.filter((span) => span.durationMs > 500);
  logger.info("[shared-eliza-runtime] provider latency", {
    traceId: input.traceId ?? input.messageIds?.assistant ?? null,
    channelType: input.execution.channel.type,
    source: input.execution.channel.source,
    responded,
    providerSpans,
    providerBudgetTargetMs: 300,
    providerBudgetCeilingMs: 500,
  });
  if (slowProviderSpans.length > 0) {
    logger.warn("[shared-eliza-runtime] provider latency exceeded ceiling", {
      traceId: input.traceId ?? input.messageIds?.assistant ?? null,
      slowProviderSpans,
      providerBudgetCeilingMs: 500,
    });
  }
}

function routedContextIds(message: Memory): string[] {
  const metadata = message.content?.metadata;
  if (!metadata || typeof metadata !== "object") return [];
  const routing = (metadata as Record<string, unknown>)[CONTEXT_ROUTING_METADATA_KEY];
  if (!routing || typeof routing !== "object" || Array.isArray(routing)) return [];
  const record = routing as Record<string, unknown>;
  const primary = typeof record.primaryContext === "string" ? [record.primaryContext] : [];
  const secondary = Array.isArray(record.secondaryContexts)
    ? record.secondaryContexts.filter((value): value is string => typeof value === "string")
    : [];
  return [...primary, ...secondary];
}

async function executeSharedElizaRuntimeTurn(
  input: SharedElizaRuntimeTurnInput,
  onStreamChunk?: (chunk: string) => void | Promise<void>,
): Promise<RunSharedAgentTurnResult> {
  const timing = new SharedRuntimeTimingCollector(
    input.traceId ?? input.messageIds?.assistant ?? "unattributed",
    input.history.length,
  );
  let runtimeReporter: IAgentRuntime | undefined;
  const emitTiming = (outcome: SharedRuntimeTimingOutcome): SharedRuntimeTimingReceipt => {
    const receipt = timing.receipt(outcome);
    try {
      input.onRuntimeTiming?.(receipt);
    } catch (error) {
      // error-policy:J7 diagnostics must not kill the loop. Once the genuine
      // runtime exists, report through its canonical error surface; setup
      // failures before creation have only this transport-boundary logger.
      if (runtimeReporter) {
        try {
          runtimeReporter.reportError("SharedElizaRuntime.timingObserver", error, {
            traceId: input.traceId ?? null,
          });
        } catch (reportError) {
          logger.warn("[shared-eliza-runtime] timing observer report failed", {
            traceId: input.traceId ?? null,
            error: reportError instanceof Error ? reportError.message : String(reportError),
          });
        }
      }
      logger.warn("[shared-eliza-runtime] timing observer failed", {
        traceId: input.traceId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return receipt;
  };
  try {
    const result = await executeMeasuredSharedElizaRuntimeTurn(
      input,
      onStreamChunk,
      timing,
      (runtime) => {
        runtimeReporter = runtime;
      },
    );
    const receipt = emitTiming("success");
    return { ...result, timing: receipt.model };
  } catch (error) {
    emitTiming(input.abortSignal?.aborted ? "aborted" : "error");
    throw error;
  }
}

async function executeMeasuredSharedElizaRuntimeTurn(
  input: SharedElizaRuntimeTurnInput,
  onStreamChunk: ((chunk: string) => void | Promise<void>) | undefined,
  timing: SharedRuntimeTimingCollector,
  exposeRuntime: (runtime: IAgentRuntime) => void,
): Promise<RunSharedAgentTurnResult> {
  if (typeof input.execution.roomKey !== "string" || !input.execution.roomKey.trim()) {
    throw new ElizaError(
      "Eliza Shared runtime requires a trusted room key when execution authority is provided",
      {
        code: "SHARED_RUNTIME_ROOM_AUTHORITY_MISSING",
        context: { agentKey: input.agentKey },
      },
    );
  }
  const trustedRoomKey = input.execution.roomKey.trim();
  await ensureEdgeStreamingContext();
  timing.markEdgeContextReady();
  const adapter = new InMemoryDatabaseAdapter();
  let providerDispatched = false;
  const inferenceTelemetry: { summary?: InferenceTurnSummary } = {};
  let usage: SharedAgentTurnUsage | undefined;

  const modelHandler = async (
    _runtime: IAgentRuntime,
    params: GenerateTextParams,
  ): Promise<string | NativeTextModelResult | TextStreamResult> => {
    const modelCall = timing.prepareModelCall();
    const model = getInteractiveCerebrasLanguageModel(input.model, modelCall.select);
    if (!providerDispatched) {
      providerDispatched = true;
      await input.onProviderDispatch?.();
      timing.markProviderDispatched();
    }
    const generation = {
      model,
      maxRetries: SHARED_TURN_MAX_RETRIES,
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
    modelCall.begin();
    if (onStreamChunk && params.stream === true) {
      const result = streamText(generation);
      const text = Promise.resolve(result.text);
      const toolCalls = Promise.resolve(result.toolCalls);
      const finishReason = Promise.resolve(result.finishReason);
      const totalUsage = Promise.resolve(result.totalUsage);
      // error-policy:J5 aborting the provider stream rejects every pending AI
      // SDK result promise. AgentRuntime observes the textStream rejection as
      // the turn failure; these handlers prevent the sibling promises from
      // surfacing the same cancellation reason as unhandled rejections.
      void text.catch(() => {});
      void toolCalls.catch(() => {});
      void finishReason.catch(() => {});
      void totalUsage.catch(() => {});
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
            if (chunk) {
              yield chunk;
            }
          }
          return;
        }
        for await (const chunk of result.textStream) {
          if (chunk) timing.markProviderFirstText();
          yield chunk;
        }
      })();
      const streamUsage = totalUsage
        .then((value) => {
          const normalized = normalizeUsage(value);
          usage = addUsage(usage, normalized);
          return normalized;
        })
        .finally(() => modelCall.finish());
      const normalizedToolCalls = toolCalls.then((calls) =>
        calls.map((call) => ({
          id: call.toolCallId,
          name: call.toolName,
          arguments: call.input,
        })),
      );
      // error-policy:J5 the derived promises reject independently from their
      // observed AI SDK sources when a provider stream is cancelled.
      void streamUsage.catch(() => {});
      void normalizedToolCalls.catch(() => {});
      return {
        textStream,
        text,
        toolCalls: normalizedToolCalls,
        finishReason,
        usage: streamUsage,
        providerMetadata: { modelName: input.model },
      } as TextStreamResult;
    }
    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      result = await generateText({ ...generation });
    } finally {
      modelCall.finish();
    }
    if (result.text.trim()) timing.markProviderFirstText();
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
  const actionsEnabled = input.messageRole !== "system";
  const reminderPlugin =
    actionsEnabled && input.execution?.reminders
      ? createSharedRemindersEdgePlugin({
          runner: input.execution.reminders.runner,
          agentId: input.agentKey,
          delivery: input.execution.reminders.delivery,
        })
      : undefined;
  const todoPlugin =
    actionsEnabled && input.execution?.todos
      ? createTodosEdgePlugin({ store: input.execution.todos.store })
      : undefined;
  const mediaPlugin =
    actionsEnabled && input.execution?.media ? sharedMediaPlugin(input.execution.media) : undefined;
  const agentId = input.execution?.todos?.scope.agentId ?? stringToUuid(input.agentKey);
  const userEntityId =
    input.execution?.todos?.scope.entityId ?? stringToUuid(`${input.agentKey}:owner`);
  const lifecycleEntityId = stringToUuid(`${input.agentKey}:system-lifecycle`);
  const incomingEntityId = actionsEnabled ? userEntityId : lifecycleEntityId;
  const authenticatedPersonalSharedUser =
    actionsEnabled && input.execution?.authenticatedPersonalSharedUser === true;
  const runtime = createRuntime({
    agentKey: input.agentKey,
    agentId,
    actionsEnabled,
    adapter,
    character: input.character,
    modelPlugin,
    transport: sharedCapabilityTransportForSource(input.execution.channel.source),
    mediaPlugin,
    reminderPlugin,
    todoPlugin,
  });
  exposeRuntime(runtime);
  try {
    timing.markRuntimeInitializeStarted();
    await runtime.initialize({ skipMigrations: true });
    if (mediaPlugin) {
      await runtime.getServiceLoadPromise(ServiceType.MEDIA_GENERATION);
    }
    const pushDispatches: Promise<void>[] = [];
    const mobilePushDispatch = input.execution?.mobilePush?.dispatch;
    const [eventBus, notificationService] = mobilePushDispatch
      ? await Promise.all([
          runtime.getServiceLoadPromise(ServiceType.AGENT_EVENT),
          runtime.getServiceLoadPromise(ServiceType.NOTIFICATION),
        ])
      : [runtime.getService(ServiceType.AGENT_EVENT), runtime.getService(ServiceType.NOTIFICATION)];
    if (mobilePushDispatch && (!isSharedNotificationEventBus(eventBus) || !notificationService)) {
      throw new Error(
        "Eliza Shared runtime initialized mobile push without canonical notification services",
      );
    }
    const unsubscribePush =
      mobilePushDispatch && isSharedNotificationEventBus(eventBus)
        ? subscribeSharedMobilePush(eventBus, mobilePushDispatch, pushDispatches)
        : undefined;
    timing.markRuntimeReady();
    if (runtime.actions.some((action) => action.name === "VIEWS")) {
      throw new Error("Eliza Shared runtime must not register client view-navigation actions");
    }
    if (!actionsEnabled) {
      if (runtime.actions.length > 0) {
        throw new Error(
          `Eliza Shared system lifecycle runtime must register zero actions: ${runtime.actions.map((action) => action.name).join(", ")}`,
        );
      }
    } else {
      if (!runtime.actions.some((action) => action.name === webSearchEdgeAction.name)) {
        throw new Error("Eliza Shared runtime initialized without its WEB_SEARCH action");
      }
      if (!runtime.actions.some((action) => action.name === REQUEST_DEDICATED_UPGRADE_ACTION)) {
        throw new Error("Eliza Shared runtime initialized without its Dedicated review action");
      }
      if (
        !runtime.providers.some(
          (provider) => provider.name === SHARED_RUNTIME_CAPABILITIES_PROVIDER,
        )
      ) {
        throw new Error("Eliza Shared runtime initialized without its capability provider");
      }
      if (
        input.execution?.reminders &&
        !runtime.actions.some((action) => action.name === "REMINDERS")
      ) {
        throw new Error("Eliza Shared runtime initialized without its REMINDERS action");
      }
      if (input.execution?.todos && !runtime.actions.some((action) => action.name === "TODO")) {
        throw new Error("Eliza Shared runtime initialized without its TODO action");
      }
      if (
        input.execution?.media &&
        !runtime.actions.some((action) => action.name === generateMediaAction.name)
      ) {
        throw new Error("Eliza Shared runtime initialized without its GENERATE_MEDIA action");
      }
    }
    const roomId = sharedRuntimeConversationRoomId(trustedRoomKey);
    timing.markConnectionStarted();
    await runtime.ensureConnection({
      entityId: incomingEntityId,
      roomId,
      worldId: sharedRuntimeWorldId(trustedRoomKey),
      userName: actionsEnabled ? "Shared user" : "Shared lifecycle",
      source: actionsEnabled ? input.execution.channel.source : "shared-runtime-system",
      type: input.execution.channel.type,
      ...(authenticatedPersonalSharedUser
        ? {
            metadata: {
              roles: { [userEntityId]: "USER" },
              roleSources: { [userEntityId]: "manual" },
            },
          }
        : {}),
    });
    timing.markConnectionReady();
    timing.markHistoryStarted();
    if (input.history.length > 0) {
      const historyTimestamps = projectedHistoryTimestamps(input.history);
      await adapter.createMemories(
        input.history.map((message, index) => {
          const createdAt = historyTimestamps[index];
          const memory = createMessageMemory({
            id: runtimeMemoryId(message, index),
            entityId:
              message.role === "assistant"
                ? runtime.agentId
                : message.role === "system"
                  ? lifecycleEntityId
                  : userEntityId,
            agentId: runtime.agentId,
            roomId,
            content: {
              text: message.content,
              source:
                message.role === "system"
                  ? "shared-runtime-system"
                  : input.execution.channel.source,
              channelType: input.execution.channel.type,
            },
          });
          memory.createdAt = createdAt;
          if (!memory.metadata) {
            throw new Error("Projected Shared message omitted canonical metadata");
          }
          memory.metadata.timestamp = createdAt;
          return {
            tableName: "messages",
            memory,
          };
        }),
      );
    }
    timing.markHistoryReady();

    const delivered: string[] = [];
    const messageService = runtime.messageService;
    if (!messageService) {
      throw new Error("Eliza Shared runtime initialized without a message service");
    }
    const incomingMessage = createMessageMemory({
      id: stringToUuid(input.messageIds?.user ?? `${input.agentKey}:${input.message}`),
      entityId: incomingEntityId,
      agentId: runtime.agentId,
      roomId,
      content: {
        text: input.message.trim(),
        // Only the server-owned execution attestation may translate a Shared
        // turn to authenticated client-chat provenance. Connector payloads and
        // direct runtime callers remain on the fail-closed Shared source.
        source: actionsEnabled ? input.execution.channel.source : "shared-runtime-system",
        channelType: input.execution.channel.type,
        ...(input.originClientMessageId
          ? {
              chatIdempotency: {
                version: 1,
                clientMessageId: input.originClientMessageId,
              },
            }
          : {}),
      },
    });
    const result = await messageService.handleMessage(
      runtime,
      incomingMessage,
      async (content) => {
        const text = content.text?.trim();
        const attachmentUrls = (content.attachments ?? []).flatMap((attachment) =>
          typeof attachment.url === "string" && attachment.url.trim()
            ? [attachment.url.trim()]
            : [],
        );
        const channelSafeContent = [text, ...attachmentUrls].filter(Boolean).join("\n");
        if (channelSafeContent) delivered.push(channelSafeContent);
        return [];
      },
      input.abortSignal || onStreamChunk
        ? {
            ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
            ...(onStreamChunk ? { onStreamChunk } : {}),
            onInferenceTimingSummary: (summary) => {
              inferenceTelemetry.summary = summary;
            },
          }
        : {
            onInferenceTimingSummary: (summary) => {
              inferenceTelemetry.summary = summary;
            },
          },
    );
    timing.markInferenceSpans(inferenceTelemetry.summary?.spans ?? []);
    timing.markRoutingDecision(
      result?.didRespond || delivered.length > 0 ? "respond" : "silent",
      routedContextIds(incomingMessage),
    );
    unsubscribePush?.();
    const pushResults = await Promise.allSettled(pushDispatches);
    for (const pushResult of pushResults) {
      if (pushResult.status === "rejected") {
        logger.warn("[shared-eliza-runtime] mobile push dispatch failed", {
          error:
            pushResult.reason instanceof Error
              ? pushResult.reason.message
              : String(pushResult.reason),
        });
      }
    }
    const reply = delivered.at(-1)?.trim() || result?.responseContent?.text?.trim() || "";
    // A verified action may own the response and deliver it through the
    // callback with `agentVoiced`; core then correctly reports no second model
    // response. The callback receipt is still an actual user-visible delivery.
    if (!result?.didRespond && delivered.length === 0) {
      logSharedProviderSpans(input, inferenceTelemetry.summary, false);
      return {
        reply: "",
        responded: false,
        history: appendSharedInput(
          input.history,
          input.message.trim(),
          input.messageIds,
          input.messageRole,
        ),
        model: input.model,
        degraded: false,
        usage,
      };
    }
    if (!reply) {
      throw new Error("Eliza Shared runtime completed without a user-visible reply");
    }
    logSharedProviderSpans(input, inferenceTelemetry.summary, true);
    return {
      reply,
      responded: true,
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
      ...(result.actionResults?.length ? { actionResults: result.actionResults } : {}),
    };
  } finally {
    for (const [operation, cleanup] of [
      ["stop", () => runtime.stop()],
      ["close", () => runtime.close()],
    ] as const) {
      try {
        await cleanup();
      } catch (error) {
        // error-policy:J6 both teardown operations are best-effort after the
        // authoritative provider result/error. Neither may mask it, and a stop
        // failure must not prevent close from being attempted.
        logger.warn(`[shared-eliza-runtime] runtime ${operation} failed`, {
          traceId: input.traceId ?? null,
          error: error instanceof Error ? error.message : String(error),
        });
        try {
          runtime.reportError(`SharedElizaRuntime.${operation}`, error, {
            traceId: input.traceId ?? null,
          });
        } catch (reportError) {
          // error-policy:J7 reporting teardown diagnostics is itself nonfatal.
          logger.warn(`[shared-eliza-runtime] runtime ${operation} report failed`, {
            traceId: input.traceId ?? null,
            error: reportError instanceof Error ? reportError.message : String(reportError),
          });
        }
      }
    }
  }
}

export async function runSharedElizaRuntimeTurn(
  input: SharedElizaRuntimeTurnInput,
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
  input: SharedElizaRuntimeTurnInput,
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
      push({
        type: "finish",
        text: result.reply,
        ...(result.responded === false ? { responded: false } : {}),
        usage: result.usage,
        ...(result.timing ? { timing: result.timing } : {}),
        ...(result.actionResults?.length ? { actionResults: result.actionResults } : {}),
      });
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
