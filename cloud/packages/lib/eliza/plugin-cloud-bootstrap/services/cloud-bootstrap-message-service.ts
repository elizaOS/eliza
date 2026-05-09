/**
 * CloudBootstrapMessageService - Native planner message execution for cloud.
 */

import {
  type ActionResult,
  asUUID,
  ChannelType,
  type Content,
  composePromptFromState,
  createUniqueUuid,
  EventType,
  executePlannedToolCall,
  type HandlerCallback,
  type IAgentRuntime,
  type IMessageService,
  logger,
  type Media,
  type Memory,
  type MentionContext,
  ModelType,
  parseBooleanFromText,
  parseJSONObjectFromText,
  type Room,
  type State,
  truncateToCompleteSentence,
  type UUID,
} from "@elizaos/core";
import { v4 } from "uuid";
import { getRequestContext } from "@/lib/services/entity-settings/request-context";
import { createPerfTrace } from "@/lib/utils/perf-trace";
import { invalidateActionValidationCache } from "../providers/actions";
import {
  nativePlannerTemplate,
  nativeResponseTemplate,
  shouldRespondTemplate,
} from "../templates/native-planner";
import {
  type CloudMessageOptions,
  type NativePlannerActionResult,
  type StrategyMode,
  type StrategyResult,
  TRANSPARENT_META_ACTIONS,
} from "../types";
import {
  attachAvailableContexts,
  type ContextRoutingDecision,
  getActiveRoutingContexts,
  getContextRoutingFromMessage,
  parseContextRoutingMetadata,
  setContextRoutingMetadata,
} from "../utils/context-routing";
import {
  getAvailableActionNames,
  parseNativePlannerDecision,
  toNativeActionParams,
  type ValidatedNativePlannerDecision,
  validateNativePlannerDecision,
} from "../utils/native-planner-guards";
import {
  cleanupLatestResponseId,
  getLatestResponseId,
  isLatestResponseId,
  setLatestResponseId,
} from "../utils/race-tracking";
import { refreshStateAfterAction } from "../utils/state";

type RuntimeWithEvaluators = IAgentRuntime & {
  evaluate?: (
    message: Memory,
    state: State,
    didRespond: boolean,
    callback: HandlerCallback,
    responseMessages: Memory[],
  ) => Promise<unknown>;
};

const RETRY_CONFIG = {
  baseDelayMs: 200,
  maxDelayMs: 1000,
  backoffMultiplier: 2,
} as const;

const EMPTY_STATE: State = { values: {}, data: {}, text: "" } as State;

type ScopedSettingOverride = {
  key: string;
  value: string;
};

function readTrimmedSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveNanoModel(runtime: IAgentRuntime): string | undefined {
  return readTrimmedSetting(runtime, "ELIZAOS_CLOUD_NANO_MODEL");
}

function resolveMediumModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_MEDIUM_MODEL") ||
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_SMALL_MODEL") ||
    readTrimmedSetting(runtime, "SMALL_MODEL")
  );
}

function resolveSmallModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_SMALL_MODEL") ||
    readTrimmedSetting(runtime, "SMALL_MODEL")
  );
}

function resolveLargeModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_LARGE_MODEL") ||
    readTrimmedSetting(runtime, "LARGE_MODEL")
  );
}

function resolveShouldRespondStepModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_HANDLER_MODEL") ||
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_SHOULD_RESPOND_MODEL") ||
    resolveNanoModel(runtime) ||
    resolveSmallModel(runtime)
  );
}

function resolveActionPlannerStepModel(runtime: IAgentRuntime): string | undefined {
  return (
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_ACTION_PLANNER_MODEL") ||
    readTrimmedSetting(runtime, "ELIZAOS_CLOUD_PLANNER_MODEL") ||
    resolveMediumModel(runtime) ||
    resolveSmallModel(runtime)
  );
}

function resolveResponseStepModel(runtime: IAgentRuntime): string | undefined {
  return readTrimmedSetting(runtime, "ELIZAOS_CLOUD_RESPONSE_MODEL") || resolveLargeModel(runtime);
}

async function withScopedSettings<T>(
  overrides: ScopedSettingOverride[],
  operation: () => Promise<T>,
): Promise<T> {
  const requestContext = getRequestContext();
  if (!requestContext || overrides.length === 0) {
    return await operation();
  }

  const previousValues = new Map<
    string,
    { hadValue: boolean; value: string | boolean | number | null | undefined }
  >();

  for (const override of overrides) {
    previousValues.set(override.key, {
      hadValue: requestContext.entitySettings.has(override.key),
      value: requestContext.entitySettings.get(override.key),
    });
    requestContext.entitySettings.set(override.key, override.value);
  }

  try {
    return await operation();
  } finally {
    for (const override of overrides) {
      const previous = previousValues.get(override.key);
      if (!previous) {
        continue;
      }
      if (previous.hadValue) {
        requestContext.entitySettings.set(override.key, previous.value ?? null);
      } else {
        requestContext.entitySettings.delete(override.key);
      }
    }
  }
}

async function withScopedTextModel<T>(
  size: "small" | "large",
  model: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!model) {
    return await operation();
  }

  const overrides =
    size === "small"
      ? [
          { key: "ELIZAOS_CLOUD_SMALL_MODEL", value: model },
          { key: "SMALL_MODEL", value: model },
        ]
      : [
          { key: "ELIZAOS_CLOUD_LARGE_MODEL", value: model },
          { key: "LARGE_MODEL", value: model },
        ];

  return await withScopedSettings(overrides, operation);
}

function parseStructuredModelObject(raw: string): Record<string, unknown> | null {
  return parseJSONObjectFromText(raw);
}

const SINGLE_SHOT_TEMPLATE = `task: Generate a response for {{agentName}}.

context:
{{providers}}

instructions:
Write a response for {{agentName}} based on the conversation.
Use available native tools only when the runtime exposes them through the planner path.

output:
JSON only. Return exactly one object:
{
  "thought": "short internal rationale",
  "actions": [],
  "text": "user-visible response"
}`;

function getRetryDelay(attempt: number): number {
  const delay = RETRY_CONFIG.baseDelayMs * RETRY_CONFIG.backoffMultiplier ** (attempt - 1);
  return Math.min(delay, RETRY_CONFIG.maxDelayMs);
}

async function withRetry<T>(
  operation: () => Promise<T>,
  validate: (result: T) => boolean,
  maxRetries: number,
  label: string,
): Promise<T | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = await operation();
      if (validate(result)) {
        logger.debug(`[NativePlanner] ${label} succeeded on attempt ${attempt}`);
        return result;
      }
      logger.warn(`[NativePlanner] ${label} validation failed on attempt ${attempt}/${maxRetries}`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        `[NativePlanner] ${label} error on attempt ${attempt}/${maxRetries}:`,
        errorMessage,
      );
      if (attempt >= maxRetries) throw error;
    }

    if (attempt < maxRetries) {
      await new Promise((r) => setTimeout(r, getRetryDelay(attempt)));
    }
  }
  return null;
}

interface MessageProcessingResult {
  didRespond: boolean;
  responseContent: Content | null;
  responseMessages: Memory[];
  state: State;
  mode: StrategyMode;
}

interface ResponseDecision {
  shouldRespond: boolean;
  skipEvaluation: boolean;
  reason: string;
}

export class CloudBootstrapMessageService implements IMessageService {
  private async evaluateShouldRespond(
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<{
    responseObject: Record<string, unknown> | null;
    routing: ContextRoutingDecision;
  }> {
    let evalState = await runtime.composeState(
      message,
      ["RECENT_MESSAGES", "CHARACTER", "ENTITIES"],
      true,
    );
    evalState = attachAvailableContexts(evalState, runtime as never);

    const shouldRespondPrompt = composePromptFromState({
      state: evalState,
      template: runtime.character.templates?.shouldRespondTemplate || shouldRespondTemplate,
    });

    logger.info("========== LLM CALL: shouldRespond ==========");
    logger.info(`[LLM:shouldRespond] System Prompt:\n${runtime.character.system || "(none)"}`);
    logger.info(`[LLM:shouldRespond] User Prompt:\n${shouldRespondPrompt}`);
    logger.info("==============================================");

    const response = await withScopedTextModel(
      "small",
      resolveShouldRespondStepModel(runtime),
      async () =>
        await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt: shouldRespondPrompt,
        }),
    );

    logger.info(`[LLM:shouldRespond] Response:\n${response}`);

    const responseObject = parseStructuredModelObject(String(response));

    return {
      responseObject,
      routing: parseContextRoutingMetadata(responseObject),
    };
  }

  async handleMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
    options?: CloudMessageOptions,
  ): Promise<MessageProcessingResult> {
    const timeoutDuration = options?.timeoutDuration ?? 60 * 60 * 1000; // 1 hour default
    let timeoutId: NodeJS.Timeout | undefined;
    let runId: UUID | undefined;
    // Initialize startTime at declaration to avoid non-null assertion in timeout callback
    const startTime = Date.now();
    const responseId = v4();

    try {
      logger.info(
        `[CloudBootstrap] Message received from ${message.entityId} in room ${message.roomId}`,
      );

      // Set up response tracking
      const previousResponseId = await getLatestResponseId(runtime.agentId, message.roomId);
      if (previousResponseId) {
        logger.debug(`[CloudBootstrap] Updating response ID for room ${message.roomId}`);
      }
      await setLatestResponseId(runtime.agentId, message.roomId, responseId);

      // Start run tracking
      runId = runtime.startRun(message.roomId) as UUID;

      await runtime.emitEvent(EventType.RUN_STARTED, {
        runtime,
        runId,
        messageId: message.id!,
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: "started",
        source: "CloudBootstrapMessageService",
      } as never);

      // Set up timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(async () => {
          await runtime.emitEvent(EventType.RUN_TIMEOUT, {
            runtime,
            runId,
            messageId: message.id!,
            roomId: message.roomId,
            entityId: message.entityId,
            startTime,
            status: "timeout",
            endTime: Date.now(),
            duration: Date.now() - startTime,
            error: "Run exceeded timeout",
            source: "CloudBootstrapMessageService",
          } as never);
          reject(new Error("Run exceeded timeout"));
        }, timeoutDuration);
      });

      const processingPromise = this.processMessage(
        runtime,
        message,
        callback,
        responseId,
        runId,
        startTime,
        options,
      );

      const result = await Promise.race([processingPromise, timeoutPromise]);

      clearTimeout(timeoutId);
      return result;
    } catch (error) {
      await cleanupLatestResponseId(runtime.agentId, message.roomId, responseId);

      // Emit RUN_ENDED event on error so tracking is complete
      if (runId && startTime) {
        await runtime.emitEvent(EventType.RUN_ENDED, {
          runtime,
          runId,
          messageId: message.id!,
          roomId: message.roomId,
          entityId: message.entityId,
          startTime,
          status: "error",
          endTime: Date.now(),
          duration: Date.now() - startTime,
          error: error instanceof Error ? error.message : String(error),
          source: "CloudBootstrapMessageService",
        } as never);
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async processMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback: HandlerCallback | undefined,
    responseId: string,
    runId: UUID,
    startTime: number,
    options?: CloudMessageOptions,
  ): Promise<MessageProcessingResult> {
    // PERF: Granular timing for message processing phases
    const perfTrace = createPerfTrace("cloud-bootstrap-message");
    perfTrace.mark("init");

    // Skip messages from self
    if (message.entityId === runtime.agentId) {
      logger.debug(`[CloudBootstrap] Skipping message from self`);
      await this.emitRunEnded(runtime, runId, message, startTime, "self");
      return {
        didRespond: false,
        responseContent: null,
        responseMessages: [],
        state: EMPTY_STATE,
        mode: "none",
      };
    }

    logger.debug(
      `[CloudBootstrap] Processing: ${truncateToCompleteSentence(message.content.text || "", 50)}...`,
    );

    // Save incoming message to memory
    let memoryToQueue: Memory;
    if (message.id) {
      const existingMemory = await runtime.getMemoryById(message.id);
      if (existingMemory) {
        memoryToQueue = existingMemory;
      } else {
        const createdMemoryId = await runtime.createMemory(message, "messages");
        memoryToQueue = { ...message, id: createdMemoryId };
      }
      await runtime.queueEmbeddingGeneration(memoryToQueue, "high");
    } else {
      const memoryId = await runtime.createMemory(message, "messages");
      message.id = memoryId;
      memoryToQueue = { ...message, id: memoryId };
      await runtime.queueEmbeddingGeneration(memoryToQueue, "normal");
    }

    // Check LLM off by default setting
    const agentUserState = await runtime.getParticipantUserState(message.roomId, runtime.agentId);
    const defLlmOff = parseBooleanFromText(String(runtime.getSetting("BOOTSTRAP_DEFLLMOFF") ?? ""));

    if (defLlmOff && agentUserState === null) {
      logger.debug("[CloudBootstrap] LLM is off by default");
      await this.emitRunEnded(runtime, runId, message, startTime, "off");
      return {
        didRespond: false,
        responseContent: null,
        responseMessages: [],
        state: EMPTY_STATE,
        mode: "none",
      };
    }

    // Check if room is muted
    const isMuted =
      agentUserState === "MUTED" &&
      !message.content.text?.toLowerCase().includes(runtime.character.name?.toLowerCase() ?? "");
    if (isMuted) {
      logger.debug(`[CloudBootstrap] Ignoring muted room ${message.roomId}`);
      await this.emitRunEnded(runtime, runId, message, startTime, "muted");
      return {
        didRespond: false,
        responseContent: null,
        responseMessages: [],
        state: EMPTY_STATE,
        mode: "none",
      };
    }

    // Process attachments if any
    if (message.content.attachments && message.content.attachments.length > 0) {
      logger.debug(`[CloudBootstrap] Processing ${message.content.attachments.length} attachments`);
      message.content.attachments = await this.processAttachments(
        runtime,
        message.content.attachments,
      );
    }

    // Get room context for shouldRespond decision
    const room = await runtime.getRoom(message.roomId);

    // Extract mention context from message metadata
    const metadata = message.content.metadata as Record<string, unknown> | undefined;
    const mentionContext: MentionContext | undefined = metadata
      ? {
          isMention: !!metadata.isMention,
          isReply: !!metadata.isReply,
          isThread: !!metadata.isThread,
          mentionType: metadata.mentionType as MentionContext["mentionType"],
        }
      : undefined;

    // Check if we should respond
    const respondDecision = this.shouldRespond(runtime, message, room ?? undefined, mentionContext);
    logger.debug(
      `[CloudBootstrap] shouldRespond: ${respondDecision.shouldRespond} (${respondDecision.reason})`,
    );

    // Determine if we should respond, using LLM evaluation if needed
    let shouldRespondToMessage = true;

    let routedDecision: ContextRoutingDecision | null = null;

    if (respondDecision.skipEvaluation) {
      shouldRespondToMessage = respondDecision.shouldRespond;
      if (respondDecision.shouldRespond) {
        const evaluated = await this.evaluateShouldRespond(runtime, message);
        routedDecision = evaluated.routing;
        setContextRoutingMetadata(message, routedDecision);
      }
    } else {
      const { responseObject, routing } = await this.evaluateShouldRespond(runtime, message);
      routedDecision = routing;
      setContextRoutingMetadata(message, routedDecision);
      const nonResponseActions = ["IGNORE", "NONE", "STOP"];
      const actionValue = responseObject?.action;

      shouldRespondToMessage =
        typeof actionValue === "string" && !nonResponseActions.includes(actionValue.toUpperCase());

      logger.debug(
        `[CloudBootstrap] LLM decided: ${shouldRespondToMessage ? "RESPOND" : "IGNORE"}`,
      );
    }

    if (!shouldRespondToMessage) {
      logger.debug(`[CloudBootstrap] Not responding based on evaluation`);
      await this.emitRunEnded(runtime, runId, message, startTime, "shouldRespond:no");
      return {
        didRespond: false,
        responseContent: null,
        responseMessages: [],
        state: EMPTY_STATE,
        mode: "none",
      };
    }

    perfTrace.mark("compose-state");
    // PERF: Compose initial state with minimal providers.
    // runNativePlannerCore fetches the full provider set (RECENT_MESSAGES, ACTIONS, etc.)
    // at the start of its decision loop. runNativeSinglePassCore fetches them before prompt
    // composition. This avoids double-fetching in the native planner path.
    let state = await runtime.composeState(message, ["ENTITIES", "CHARACTER"], true);
    state = attachAvailableContexts(state, runtime as never);

    // Determine processing mode - default to native-planner for cloud
    const useNativePlanner =
      options?.useNativePlanner ??
      parseBooleanFromText(String(runtime.getSetting("USE_NATIVE_PLANNER") ?? "true"));

    perfTrace.mark("llm-processing");
    // Run appropriate processing strategy
    let result: StrategyResult;
    if (useNativePlanner) {
      logger.debug("[CloudBootstrap] Using native-planner processing");
      result = await this.runNativePlannerCore(
        runtime,
        message,
        state,
        responseId,
        callback,
        options,
      );
    } else {
      logger.debug("[CloudBootstrap] Using single-shot processing");
      result = await this.runNativeSinglePassCore(runtime, message, state, callback, options);
    }

    const responseContent = result.responseContent;
    const responseMessages = result.responseMessages;
    state = result.state;

    // Race check before sending response
    if (!(await isLatestResponseId(runtime.agentId, message.roomId, responseId))) {
      logger.info(`[CloudBootstrap] Response discarded - newer message being processed`);
      await this.emitRunEnded(runtime, runId, message, startTime, "race-discarded");
      return {
        didRespond: false,
        responseContent: null,
        responseMessages: [],
        state,
        mode: "none",
      };
    }

    if (responseContent && message.id) {
      responseContent.inReplyTo = createUniqueUuid(runtime, message.id);
    }

    if (responseContent) {
      const mode = result.mode ?? "actions";

      if (mode === "simple") {
        // Simple mode - just call callback with content
        if (callback) {
          await callback(responseContent);
        }
      }
    }

    // Clean up response ID tracking (only if we still own it)
    await cleanupLatestResponseId(runtime.agentId, message.roomId, responseId);

    const memoryService = runtime.getService("memory") as { hasStorage?: () => boolean } | null;
    const hasEvaluatorStorage = memoryService?.hasStorage?.() !== false;

    if (hasEvaluatorStorage) {
      const runtimeWithEvaluators = runtime as RuntimeWithEvaluators;
      try {
        await runtimeWithEvaluators.evaluate?.(
          message,
          state,
          true,
          async (content: Content) => {
            if (responseContent) {
              responseContent.evalCallbacks = content;
            }
            if (callback) {
              return callback(content);
            }
            return [];
          },
          responseMessages,
        );
      } catch (error) {
        logger.warn(
          `[CloudBootstrap] Evaluators failed after response generation: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } else {
      logger.debug("[CloudBootstrap] Skipping evaluators because memory storage is unavailable");
    }

    // Emit run ended event
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      runId,
      messageId: message.id!,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: "completed",
      endTime: Date.now(),
      duration: Date.now() - startTime,
      source: "CloudBootstrapMessageService",
    } as never);

    perfTrace.mark("finalize");
    perfTrace.end();
    logger.info(`[CloudBootstrap] Completed in ${Date.now() - startTime}ms`);

    return {
      didRespond: true,
      responseContent,
      responseMessages,
      state,
      mode: result.mode,
    };
  }

  /**
   * Native planner execution: ONE JSON planner tool call at a time.
   * Decision phase selects the next action; summary phase writes the user-facing response.
   */
  private async runNativePlannerCore(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    responseId: string,
    callback?: HandlerCallback,
    options?: CloudMessageOptions,
  ): Promise<StrategyResult> {
    const traceActionResult: NativePlannerActionResult[] = [];
    const discoveredActions = new Set<string>();
    let totalActionsExecuted = 0;
    let lastActionKey = "";
    let accumulatedState: State = state;
    let finishResponse: string | null = null;
    const activeContexts = getActiveRoutingContexts(getContextRoutingFromMessage(message));

    // Save the original system prompt so we can restore it after the native planner loop.
    // The decision phase uses a functional system prompt (embedded in the template),
    // but runtime.character.system is still passed to the LLM by the OpenAI plugin.
    // If the agent has no system prompt configured, the empty string causes OpenAI to
    // reject the request ("Each message must have content..."). Set a fallback.
    const originalSystemPrompt = runtime.character.system;
    if (!runtime.character.system) {
      runtime.character.system =
        "You are an AI task executor that helps complete user requests by selecting and executing actions.";
    }

    const maxIterations =
      options?.maxNativePlannerIterations ??
      parseInt(String(runtime.getSetting("NATIVE_PLANNER_MAX_ITERATIONS") ?? "6"));
    const maxConsecutiveFailures = parseInt(
      String(runtime.getSetting("NATIVE_PLANNER_MAX_CONSECUTIVE_FAILURES") ?? "2"),
    );
    let iterationCount = 0;
    let consecutiveFailures = 0;
    let incompleteReason: string | null = null;
    let wasCancelled = false;

    try {
      // ASSUMPTION: MCP service init already completed during runtime creation
      // (RuntimeFactory.waitForMcpServiceIfNeeded). If RuntimeFactory changes to
      // skip that call, MCP tools will be missing on the first message.

      // PERF: Fetch providers once upfront. ACTIONS and USER_AUTH_STATUS are truly stable
      // for the request lifetime. RECENT_MESSAGES is cached here to give the decision LLM
      // a consistent view during the loop; the summary step re-fetches it fresh.
      accumulatedState = await runtime.composeState(
        message,
        [
          "RECENT_MESSAGES",
          "ACTION_STATE",
          "ACTIONS",
          "CHARACTER",
          "USER_AUTH_STATUS",
          // NOTE: "MCP" provider removed - MCP tools are now registered as native actions
          // via McpService.registerToolsAsActions() and appear in ACTIONS provider
        ],
        true,
      );
      (accumulatedState.data as any).actionResults = traceActionResult;

      // Snapshot provider values for use in the decision loop. ACTIONS and USER_AUTH_STATUS
      // are truly stable. RECENT_MESSAGES is intentionally frozen here so the decision LLM
      // sees a consistent baseline; the summary step fetches fresh RECENT_MESSAGES.
      //
      // TRADE-OFF: Actions that write to memory (notes, lookups, etc.) during iteration N
      // will NOT be visible in recentMessages for the decision at iteration N+1. This is
      // acceptable because (a) the decision prompt focuses on action selection, not memory
      // recall, and (b) refreshing recentMessages per iteration would add ~200-400ms each.
      // If a future action requires cross-iteration memory visibility, fetch fresh
      // recentMessages inside that specific iteration instead of using the cached snapshot.
      const cachedStableValues: Record<string, unknown> = {};
      const stableProviderKeys = [
        "recentMessages",
        "actions",
        "actionNames",
        "actionsWithParams",
        "nativeToolsJson",
        "userAuthStatus",
      ];
      for (const key of stableProviderKeys) {
        const val =
          accumulatedState.values?.[key] ?? (accumulatedState as Record<string, unknown>)[key];
        if (val !== undefined) {
          cachedStableValues[key] = val;
        }
      }
      // Also cache provider data (used by action execution, not templates)
      const cachedStableData = accumulatedState.data
        ? { actionsData: accumulatedState.data.actionsData }
        : {};

      const streamThinking = async (phase: string, content: string): Promise<void> => {
        if (options?.onReasoningChunk) {
          await options.onReasoningChunk(
            content,
            phase as "planning" | "actions" | "response" | "thinking",
            message.id as UUID,
          );
        }
      };

      while (iterationCount < maxIterations) {
        if (!(await isLatestResponseId(runtime.agentId, message.roomId, responseId))) {
          logger.info("[NativePlanner] Newer message detected, cancelling stale execution");
          wasCancelled = true;
          break;
        }

        iterationCount++;
        logger.debug(`[NativePlanner] Starting iteration ${iterationCount}/${maxIterations}`);

        await streamThinking("thinking", `\n--- Step ${iterationCount}/${maxIterations} ---\n`);

        // Inject actionResults into message metadata BEFORE composeState
        // so ACTION_STATE provider can read it during state composition
        const messageWithResults = {
          ...message,
          content: {
            ...message.content,
            metadata: {
              ...((message.content as any).metadata || {}),
              actionResults: traceActionResult,
            },
          },
        };

        // Only refresh ACTION_STATE + CHARACTER per iteration. ACTIONS, USER_AUTH_STATUS,
        // and RECENT_MESSAGES are stable for the request lifetime and reused from cache.
        const actionOnlyState = await runtime.composeState(
          messageWithResults,
          ["ACTION_STATE", "CHARACTER"],
          true,
        );
        // Merge: start with fresh ACTION_STATE, overlay cached stable provider values
        accumulatedState = {
          ...actionOnlyState,
          values: { ...actionOnlyState.values, ...cachedStableValues } as any,
          data: { ...actionOnlyState.data, ...cachedStableData },
        };
        // Also set on state.data for consistency
        (accumulatedState.data as any).actionResults = traceActionResult;

        const remainingSteps = maxIterations - iterationCount;
        const stateWithIterationContext = {
          ...accumulatedState,
          currentDateTime: new Date().toISOString(),
          iterationCount,
          maxIterations,
          traceActionResult,
          totalActionsExecuted,
          discoveredActions: discoveredActions.size > 0 ? [...discoveredActions].join(", ") : "",
          stepsWarning: remainingSteps <= 2,
          remainingSteps,
        };

        const prompt = composePromptFromState({
          state: stateWithIterationContext,
          template: runtime.character.templates?.nativePlannerTemplate || nativePlannerTemplate,
        });

        // === LLM CALL LOG: nativePlanner ===
        logger.info(
          `========== LLM CALL: nativePlanner (iteration ${iterationCount}/${maxIterations}) ==========`,
        );
        logger.info(`[LLM:nativePlanner] System Prompt:\n${runtime.character.system}`);
        logger.info(`[LLM:nativePlanner] User Prompt:\n${prompt}`);
        logger.info("==============================================");

        // PERF: Reduced from 5 to 3 retries. Each retry adds 1-4s with exponential backoff.
        // 3 balances latency (~6-12s max) vs. reliability for complex native-planner queries
        // where LLMs occasionally produce malformed JSON. Override via NATIVE_PLANNER_PARSE_RETRIES.
        const maxParseRetries = parseInt(
          String(runtime.getSetting("NATIVE_PLANNER_PARSE_RETRIES") ?? "2"),
        );
        let stepResultRaw = "";
        let parsedStep: ValidatedNativePlannerDecision | null = null;

        for (let parseAttempt = 1; parseAttempt <= maxParseRetries; parseAttempt++) {
          try {
            logger.debug(
              `[NativePlanner] Decision model call attempt ${parseAttempt}/${maxParseRetries}`,
            );

            stepResultRaw = await withScopedTextModel(
              "small",
              resolveActionPlannerStepModel(runtime),
              async () =>
                await runtime.useModel(ModelType.TEXT_SMALL, {
                  prompt,
                }),
            );

            logger.info(
              `[LLM:nativePlanner] Response (attempt ${parseAttempt}):\n${stepResultRaw}`,
            );
            const rawParsedStep = parseNativePlannerDecision(stepResultRaw);
            if (rawParsedStep) {
              const validation = validateNativePlannerDecision(
                rawParsedStep,
                getAvailableActionNames(accumulatedState.data.actionsData),
              );
              if (validation.error) {
                logger.warn(
                  `[NativePlanner] Invalid planner output on attempt ${parseAttempt}/${maxParseRetries}: ${validation.error}`,
                );
                if (parseAttempt < maxParseRetries) {
                  const delay = getRetryDelay(parseAttempt);
                  await new Promise((resolve) => setTimeout(resolve, delay));
                }
                continue;
              }
              parsedStep = validation.decision || null;
            }

            if (parsedStep) {
              logger.debug(`[NativePlanner] Successfully parsed on attempt ${parseAttempt}`);

              if (parsedStep.thought && options?.onReasoningChunk) {
                await streamThinking("planning", parsedStep.thought);
              }
              break;
            } else {
              logger.warn(
                `[NativePlanner] Failed to parse planner JSON on attempt ${parseAttempt}/${maxParseRetries}`,
              );
              if (parseAttempt < maxParseRetries) {
                const delay = getRetryDelay(parseAttempt);
                await new Promise((resolve) => setTimeout(resolve, delay));
              }
            }
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error(
              `[NativePlanner] Error during model call attempt ${parseAttempt}:`,
              errorMessage,
            );
            if (parseAttempt >= maxParseRetries) {
              throw error;
            }
            const delay = getRetryDelay(parseAttempt);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }

        if (!parsedStep) {
          logger.warn(
            `[NativePlanner] Failed to parse step result after ${maxParseRetries} attempts`,
          );
          incompleteReason = `The planner produced invalid output ${maxParseRetries} time(s) in a row.`;
          traceActionResult.push({
            data: { actionName: "parse_error" },
            success: false,
            error: `Failed to parse step result after ${maxParseRetries} attempts`,
          });
          consecutiveFailures++;
          break;
        }

        const { thought, action, isFinish, parameters } = parsedStep;

        // Dedup guard: detect identical consecutive calls
        // Sort keys for deterministic comparison (key order varies across LLM outputs)
        const canonicalParams = (() => {
          const obj = parameters || {};
          const sorted: Record<string, unknown> = {};
          for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
          return JSON.stringify(sorted);
        })();
        const dedupKey = action ? `${action}::${canonicalParams}` : "";
        if (action && dedupKey === lastActionKey) {
          logger.warn(
            `[NativePlanner] Duplicate action detected: ${action} with same params. Forcing completion.`,
          );
          traceActionResult.push({
            data: { actionName: action },
            success: false,
            error: `Duplicate call detected — ${action} was already executed with these parameters. Try a different action or set isFinish=true.`,
          });
          break;
        }
        lastActionKey = dedupKey;

        if (!action) {
          // Fallback: isFinish flag set without an explicit action
          if (isFinish) {
            logger.info(`[NativePlanner] Task complete (isFinish) at iteration ${iterationCount}`);
            await streamThinking("response", "\n--- Completing task ---\n");

            break;
          }
          logger.warn(
            `[NativePlanner] No action at iteration ${iterationCount}, forcing completion`,
          );
          break;
        }

        // Terminal planner calls produce the user-facing response directly.
        // FINISH is kept as a compatibility tool while v5 planners prefer
        // toolCalls: [] plus messageToUser.
        if (action === "FINISH") {
          const actionParams = parameters || {};
          finishResponse = (actionParams.response as string) || "";
          logger.info(
            `[NativePlanner] Terminal response returned at iteration ${iterationCount}, response length: ${finishResponse.length}`,
          );
          await streamThinking("response", "\n--- Final response ---\n");
          break;
        }

        if (action === "REPLY" || action === "NONE") {
          const actionParams = parameters || {};
          const replyText =
            typeof actionParams.response === "string"
              ? actionParams.response
              : typeof actionParams.text === "string"
                ? actionParams.text
                : typeof actionParams.message === "string"
                  ? actionParams.message
                  : "";

          if (replyText) {
            finishResponse = replyText;
            logger.info(
              `[NativePlanner] ${action} treated as final response, length: ${replyText.length}`,
            );
          } else {
            logger.info(`[NativePlanner] ${action} requested response synthesis`);
          }
          await streamThinking("response", `\n--- ${action} ---\n`);
          break;
        }

        try {
          if (!(await isLatestResponseId(runtime.agentId, message.roomId, responseId))) {
            logger.info(
              "[NativePlanner] Newer message detected before action execution, cancelling",
            );
            wasCancelled = true;
            break;
          }

          if (!accumulatedState.data) accumulatedState.data = {};
          if (!accumulatedState.data.workingMemory) accumulatedState.data.workingMemory = {};

          const actionParams = parameters || {};
          if (Object.keys(actionParams).length > 0) {
            logger.debug(`[NativePlanner] Parsed parameters: ${JSON.stringify(actionParams)}`);
          }

          const hasActionParams = Object.keys(actionParams).length > 0;

          if (action && hasActionParams) {
            accumulatedState.data.actionParams = actionParams;
            accumulatedState.data.params = toNativeActionParams(action, actionParams);
            const actionKey = action.toLowerCase().replace(/_/g, "");
            accumulatedState.data[actionKey] = {
              ...actionParams,
              _source: "nativePlanner",
              _timestamp: Date.now(),
            };
            logger.info(
              `[NativePlanner] Stored parameters for ${action}: ${JSON.stringify(actionParams)}`,
            );
          }

          await streamThinking(
            "actions",
            `\nExecuting action: ${action}${hasActionParams ? ` with params: ${JSON.stringify(actionParams)}` : ""}\n`,
          );

          const actionMessage: Memory = hasActionParams
            ? {
                ...message,
                content: {
                  ...(message.content as Record<string, unknown>),
                  params: toNativeActionParams(action, actionParams),
                  actionParams,
                  actionInput: actionParams,
                } as Content,
              }
            : message;

          let capturedCallback: Content | undefined;
          const result = await executePlannedToolCall(
            runtime,
            {
              message: actionMessage,
              state: accumulatedState,
              activeContexts,
              previousResults: traceActionResult as ActionResult[],
              callback: async (content) => {
                capturedCallback = content;
                return [];
              },
              responses: [
                {
                  id: v4() as UUID,
                  entityId: runtime.agentId,
                  roomId: message.roomId,
                  createdAt: Date.now(),
                  content: {
                    text: `Executing action: ${action}`,
                    actions: [action],
                    thought: thought ?? "",
                  },
                },
              ],
            },
            hasActionParams ? { name: action, params: actionParams } : { name: action },
            options?.onStreamChunk ? { onStreamChunk: options.onStreamChunk } : undefined,
          );
          const resultText =
            typeof result.text === "string" && result.text.length > 0
              ? result.text
              : capturedCallback?.text;
          const success = (result?.success as boolean) ?? false;

          const actionResult: NativePlannerActionResult = {
            data: { actionName: action },
            success,
            text: resultText,
            values: result?.values as Record<string, unknown> | undefined,
            error: success ? undefined : resultText,
          };

          // Transparent meta-actions (e.g., SEARCH_ACTIONS) don't appear in
          // # Previous Action Results on success — their side-effects (registering
          // new actions) are sufficient. Failures are still recorded so the LLM
          // can retry with different parameters.
          const isTransparent = TRANSPARENT_META_ACTIONS.has(action) && actionResult.success;
          if (!isTransparent) {
            traceActionResult.push(actionResult);
          }
          totalActionsExecuted++;
          consecutiveFailures = success ? 0 : consecutiveFailures + 1;

          // Track newly discovered actions from SEARCH_ACTIONS for explicit visibility
          if (action === "SEARCH_ACTIONS" && actionResult.success && result) {
            const data = result.data as Record<string, unknown> | undefined;
            const newlyRegistered = data?.newlyRegistered as string[] | undefined;
            if (newlyRegistered?.length) {
              newlyRegistered.forEach((name) => discoveredActions.add(name));
              if (message.id) {
                invalidateActionValidationCache(String(message.id));
              }
              logger.info(`[NativePlanner] Discovered actions: ${newlyRegistered.join(", ")}`);
            }
          }

          await streamThinking(
            "actions",
            `\nAction ${action} ${success ? "succeeded" : "failed"}: ${actionResult.text || "(no output)"}\n`,
          );

          accumulatedState = await refreshStateAfterAction(
            runtime,
            message,
            accumulatedState,
            traceActionResult,
          );

          // Check if action requires user input before continuing
          const resultData = result?.data as Record<string, unknown> | undefined;
          if (resultData?.awaitingUserInput === true) {
            logger.info(`[NativePlanner] Action ${action} awaiting user input, pausing loop`);
            break;
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.error(`[NativePlanner] Error executing action ${action}: ${errorMessage}`);
          traceActionResult.push({
            data: { actionName: action || "unknown" },
            success: false,
            error: errorMessage,
          });

          await streamThinking("actions", `\nAction ${action} error: ${errorMessage}\n`);
          consecutiveFailures++;
        }

        if (consecutiveFailures >= maxConsecutiveFailures) {
          incompleteReason = `The last ${consecutiveFailures} action attempt(s) failed, so execution was stopped early.`;
          logger.warn(
            `[NativePlanner] Failure budget exhausted after ${consecutiveFailures} consecutive failures`,
          );
          break;
        }

        // Compatibility fallback for older planners that set isFinish separately.
        if (isFinish) {
          logger.info(
            `[NativePlanner] Task complete (isFinish fallback) at iteration ${iterationCount}`,
          );
          break;
        }
      }

      if (iterationCount >= maxIterations) {
        logger.warn(`[NativePlanner] Reached maximum iterations (${maxIterations})`);
        if (!finishResponse && !incompleteReason) {
          incompleteReason = `The task hit the ${maxIterations}-step limit before it finished.`;
        }
      }

      if (wasCancelled) {
        return {
          responseContent: null,
          responseMessages: [],
          state: accumulatedState,
          mode: "none",
        };
      }

      // If a terminal response was returned, use it directly and skip summary generation.
      if (finishResponse !== null) {
        logger.info("[NativePlanner] Using terminal response, skipping summary LLM call");

        const responseContent: Content = {
          actions: ["FINISH"],
          text: finishResponse,
          thought: "Terminal response returned by planner.",
          simple: true,
        };

        if (options?.onStreamChunk) {
          await options.onStreamChunk(finishResponse, message.id as UUID);
        }

        const responseMessages: Memory[] = [
          {
            id: asUUID(v4()),
            entityId: runtime.agentId,
            agentId: runtime.agentId,
            content: responseContent,
            roomId: message.roomId,
            createdAt: Date.now(),
          },
        ];

        return {
          responseContent,
          responseMessages,
          state: accumulatedState,
          mode: "simple",
        };
      }

      // Fallback: summary LLM call when the planner stopped without a terminal response.
      await streamThinking("response", "\n--- Generating final response ---\n");

      // Inject actionResults into message metadata BEFORE composeState
      // so ACTION_STATE provider can read them during state composition
      const summaryMessageWithResults = {
        ...message,
        content: {
          ...message.content,
          metadata: {
            ...((message.content as any).metadata || {}),
            actionResults: traceActionResult,
          },
        },
      };

      // Fetch all providers fresh for the summary. RECENT_MESSAGES will include
      // messages created by action execution, which the summary LLM needs to see.
      const summaryFreshState = await runtime.composeState(
        summaryMessageWithResults,
        [
          "RECENT_MESSAGES",
          "ACTION_STATE",
          "ACTIONS",
          "CHARACTER",
          "USER_AUTH_STATUS",
          "APP_CONFIG",
        ],
        true,
      );
      // Summary merge: fresh values take precedence over cached. RECENT_MESSAGES
      // changed after actions executed, so the stale cached copy must NOT win.
      accumulatedState = {
        ...summaryFreshState,
        values: { ...cachedStableValues, ...summaryFreshState.values } as any,
        data: { ...cachedStableData, ...summaryFreshState.data },
      };
      // Also set on state.data for consistency
      (accumulatedState.data as any).actionResults = traceActionResult;
      accumulatedState.totalActionsExecuted = totalActionsExecuted;
      accumulatedState.values.totalActionsExecuted = totalActionsExecuted;
      accumulatedState.values.hasActionResults = traceActionResult.length > 0;
      accumulatedState.values.executionAborted = Boolean(incompleteReason);
      accumulatedState.values.incompleteReason = incompleteReason || "";
      accumulatedState.values.discoveredActions =
        discoveredActions.size > 0 ? [...discoveredActions].join(", ") : "";
      accumulatedState.values.currentDateTime = new Date().toISOString();

      const summaryPrompt = composePromptFromState({
        state: accumulatedState,
        template: runtime.character.templates?.nativeResponseTemplate || nativeResponseTemplate,
      });

      // === LLM CALL LOG: nativeResponse ===
      logger.info("========== LLM CALL: nativeResponse ==========");
      logger.info(`[LLM:nativeResponse] System Prompt:\n${runtime.character.system || "(none)"}`);
      logger.info(`[LLM:nativeResponse] User Prompt:\n${summaryPrompt}`);
      logger.info("==============================================");

      const maxSummaryRetries = parseInt(
        String(runtime.getSetting("NATIVE_RESPONSE_PARSE_RETRIES") ?? "2"),
      );
      let finalOutput = "";
      let summary: Record<string, unknown> | null = null;

      for (let summaryAttempt = 1; summaryAttempt <= maxSummaryRetries; summaryAttempt++) {
        try {
          logger.debug(`[NativePlanner] Summary generation attempt ${summaryAttempt}`);
          finalOutput = await withScopedTextModel(
            "large",
            resolveResponseStepModel(runtime),
            async () =>
              await runtime.useModel(ModelType.TEXT_LARGE, {
                prompt: summaryPrompt,
              }),
          );

          logger.info(`[LLM:nativeResponse] Response (attempt ${summaryAttempt}):\n${finalOutput}`);
          summary = parseStructuredModelObject(finalOutput);

          if (summary?.text) {
            logger.debug(`[NativePlanner] Parsed summary on attempt ${summaryAttempt}`);
            break;
          } else {
            logger.warn(
              `[NativePlanner] Failed to parse JSON summary on attempt ${summaryAttempt}/${maxSummaryRetries}`,
            );
            if (summaryAttempt < maxSummaryRetries) {
              const delay = getRetryDelay(summaryAttempt);
              await new Promise((resolve) => setTimeout(resolve, delay));
            }
          }
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error(
            `[NativePlanner] Summary generation error on attempt ${summaryAttempt}:`,
            errorMessage,
          );
          if (summaryAttempt >= maxSummaryRetries) {
            logger.warn("[NativePlanner] Failed to generate summary after all retries");
            break;
          }
          const delay = getRetryDelay(summaryAttempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      let responseContent: Content | null = null;
      if (summary?.text) {
        responseContent = {
          actions: ["NATIVE_RESPONSE"],
          text: summary.text as string,
          thought:
            (summary.thought as string) || "Final user-facing message after task completion.",
          simple: true,
        };

        if (options?.onStreamChunk) {
          await options.onStreamChunk(summary.text as string, message.id as UUID);
        }
      } else {
        logger.warn(`[NativePlanner] No valid summary generated, using fallback`);
        const fallbackText =
          "I completed the requested actions, but encountered an issue generating the summary.";
        responseContent = {
          actions: ["NATIVE_RESPONSE"],
          text: fallbackText,
          thought: "Summary generation failed after retries.",
          simple: true,
        };

        // Stream fallback text for consistent user experience
        if (options?.onStreamChunk) {
          await options.onStreamChunk(fallbackText, message.id as UUID);
        }
      }

      const responseMessages: Memory[] = responseContent
        ? [
            {
              id: asUUID(v4()),
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              content: responseContent,
              roomId: message.roomId,
              createdAt: Date.now(),
            },
          ]
        : [];

      return {
        responseContent,
        responseMessages,
        state: accumulatedState,
        mode: "simple",
      };
    } finally {
      // Restore the original system prompt so other handlers/phases
      // that share this runtime aren't affected by our fallback override.
      runtime.character.system = originalSystemPrompt;
    }
  }

  private async runNativeSinglePassCore(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    callback?: HandlerCallback,
    options?: CloudMessageOptions,
  ): Promise<StrategyResult> {
    // Ensure runtime.character.system is non-empty so the OpenAI plugin
    // doesn't send an empty system message (which OpenAI rejects).
    const originalSystemPrompt = runtime.character.system;
    if (!runtime.character.system) {
      runtime.character.system = "You are a helpful AI assistant that responds to user messages.";
    }

    try {
      state = await runtime.composeState(
        message,
        ["RECENT_MESSAGES", "ACTIONS", "CHARACTER"],
        true,
      );

      const template = runtime.character.templates?.messageHandlerTemplate || SINGLE_SHOT_TEMPLATE;
      const prompt = composePromptFromState({ state, template });

      logger.info("========== LLM CALL: singleShot ==========");
      logger.info(`[LLM:singleShot] System Prompt:\n${runtime.character.system || "(none)"}`);
      logger.info(`[LLM:singleShot] User Prompt:\n${prompt}`);
      logger.info("==============================================");

      const maxRetries = options?.maxRetries ?? 3;
      const parsedResponse = await withRetry(
        async () => {
          const response = String(
            await withScopedTextModel(
              "small",
              resolveActionPlannerStepModel(runtime),
              async () =>
                await runtime.useModel(ModelType.TEXT_SMALL, {
                  prompt,
                }),
            ),
          );
          logger.info(`[LLM:singleShot] Response:\n${response}`);
          return parseStructuredModelObject(response);
        },
        (result) => !!(result?.text || result?.thought),
        maxRetries,
        "singleShot",
      );

      if (!parsedResponse) {
        logger.error("[CloudBootstrap] All single-shot attempts failed");
        return {
          responseContent: null,
          responseMessages: [],
          state,
          mode: "none",
        };
      }

      const actions = Array.isArray(parsedResponse.actions)
        ? parsedResponse.actions
            .map((action) => (typeof action === "string" ? action.trim() : ""))
            .filter(Boolean)
        : parsedResponse.actions
          ? String(parsedResponse.actions)
              .split(",")
              .map((action: string) => action.trim())
              .filter(Boolean)
          : [];

      const responseContent: Content = {
        text: String(parsedResponse.text || ""),
        thought: String(parsedResponse.thought || ""),
        actions,
        source: message.content.source,
        inReplyTo: message.id ? createUniqueUuid(runtime, message.id) : undefined,
      };

      if (options?.onStreamChunk && responseContent.text) {
        await options.onStreamChunk(responseContent.text, message.id as UUID);
      }

      const responseMessages: Memory[] = responseContent.text
        ? [
            {
              id: asUUID(v4()),
              entityId: runtime.agentId,
              agentId: runtime.agentId,
              roomId: message.roomId,
              content: responseContent,
              createdAt: Date.now(),
            },
          ]
        : [];

      return {
        responseContent: responseContent.text ? responseContent : null,
        responseMessages,
        state,
        mode: actions.length ? "actions" : "simple",
      };
    } finally {
      runtime.character.system = originalSystemPrompt;
    }
  }

  shouldRespond(
    runtime: IAgentRuntime,
    message: Memory,
    room?: Room,
    mentionContext?: MentionContext,
  ): ResponseDecision {
    if (!room) {
      return {
        shouldRespond: false,
        skipEvaluation: true,
        reason: "no room context",
      };
    }

    const alwaysRespondChannels = [
      ChannelType.DM,
      ChannelType.VOICE_DM,
      ChannelType.SELF,
      ChannelType.API,
    ];

    const alwaysRespondSources = ["client_chat"];

    function normalizeEnvList(value: unknown): string[] {
      if (!value || typeof value !== "string") return [];
      const cleaned = value.trim().replace(/^\[|\]$/g, "");
      return cleaned
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
    }

    const customChannels = normalizeEnvList(
      runtime.getSetting("ALWAYS_RESPOND_CHANNELS") ||
        runtime.getSetting("SHOULD_RESPOND_BYPASS_TYPES"),
    );
    const customSources = normalizeEnvList(
      runtime.getSetting("ALWAYS_RESPOND_SOURCES") ||
        runtime.getSetting("SHOULD_RESPOND_BYPASS_SOURCES"),
    );

    const respondChannels = new Set(
      [...alwaysRespondChannels.map((t) => t.toString()), ...customChannels].map((s) =>
        s.trim().toLowerCase(),
      ),
    );

    const respondSources = [...alwaysRespondSources, ...customSources].map((s) =>
      s.trim().toLowerCase(),
    );

    const roomType = room.type?.toString().toLowerCase();
    const sourceStr = message.content.source?.toLowerCase() || "";

    // DM/VOICE_DM/API channels: always respond
    if (respondChannels.has(roomType)) {
      return {
        shouldRespond: true,
        skipEvaluation: true,
        reason: `private channel: ${roomType}`,
      };
    }

    // Specific sources (e.g., client_chat): always respond
    if (respondSources.some((pattern) => sourceStr.includes(pattern))) {
      return {
        shouldRespond: true,
        skipEvaluation: true,
        reason: `whitelisted source: ${sourceStr}`,
      };
    }

    // Platform mentions and replies: always respond
    const hasPlatformMention = !!(mentionContext?.isMention || mentionContext?.isReply);
    if (hasPlatformMention) {
      const mentionType = mentionContext?.isMention ? "mention" : "reply";
      return {
        shouldRespond: true,
        skipEvaluation: true,
        reason: `platform ${mentionType}`,
      };
    }

    // All other cases: let the LLM decide
    return {
      shouldRespond: false,
      skipEvaluation: false,
      reason: "needs LLM evaluation",
    };
  }

  async processAttachments(runtime: IAgentRuntime, attachments: Media[]): Promise<Media[]> {
    if (!attachments?.length) return attachments;

    return Promise.all(
      attachments.map(async (attachment) => {
        if (attachment.description) return attachment;

        const contentType = attachment.contentType || "";
        const label = attachment.title || attachment.url;

        if (contentType.startsWith("image/")) {
          try {
            const result = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
              imageUrl: attachment.url,
              prompt: "Describe this image in detail.",
            });
            attachment.description =
              typeof result === "string"
                ? result
                : (result as { description?: string })?.description || "Image attachment";
          } catch (error) {
            logger.warn(
              `[CloudBootstrap] Failed to generate image description for ${label}: ${error}`,
            );
            attachment.description = `Image: ${label}`;
          }
        } else if (
          contentType.startsWith("text/") ||
          contentType.includes("pdf") ||
          contentType.includes("document")
        ) {
          attachment.description = attachment.text
            ? `Document content: ${attachment.text.substring(0, 500)}${attachment.text.length > 500 ? "..." : ""}`
            : `Document: ${label}`;
        } else {
          attachment.description = `Attachment: ${label}`;
        }

        return attachment;
      }),
    );
  }

  async deleteMessage(runtime: IAgentRuntime, message: Memory): Promise<void> {
    if (!message.id) {
      logger.error("[CloudBootstrap] Cannot delete memory: message ID is missing");
      return;
    }

    logger.info(
      `[CloudBootstrap] Deleting memory for message ${message.id} from room ${message.roomId}`,
    );
    await runtime.deleteMemory(message.id);
  }

  async clearChannel(runtime: IAgentRuntime, roomId: UUID, channelId: string): Promise<void> {
    logger.info(
      `[CloudBootstrap] Clearing message memories from channel ${channelId} -> room ${roomId}`,
    );

    const memories = await runtime.getMemoriesByRoomIds({
      tableName: "messages",
      roomIds: [roomId],
    });

    let deletedCount = 0;
    for (const memory of memories) {
      if (memory.id) {
        try {
          await runtime.deleteMemory(memory.id);
          deletedCount++;
        } catch (error) {
          logger.warn(`[CloudBootstrap] Failed to delete memory ${memory.id}: ${error}`);
        }
      }
    }

    logger.info(
      `[CloudBootstrap] Cleared ${deletedCount}/${memories.length} memories from channel ${channelId}`,
    );
  }

  private async emitRunEnded(
    runtime: IAgentRuntime,
    runId: UUID,
    message: Memory,
    startTime: number,
    status: string,
  ): Promise<void> {
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      runId,
      messageId: message.id!,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status,
      endTime: Date.now(),
      duration: Date.now() - startTime,
      source: "CloudBootstrapMessageService",
    } as never);
  }
}
