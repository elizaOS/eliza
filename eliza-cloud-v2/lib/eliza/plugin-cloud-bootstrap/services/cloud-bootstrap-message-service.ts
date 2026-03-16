/**
 * CloudBootstrapMessageService - Multi-step message execution for eliza-cloud-v2.
 */
import { v4 } from "uuid";
import {
  type IAgentRuntime,
  type Memory,
  type Content,
  type UUID,
  type State,
  type HandlerCallback,
  type IMessageService,
  type Room,
  type MentionContext,
  type Media,
  ChannelType,
  EventType,
  ModelType,
  asUUID,
  createUniqueUuid,
  composePromptFromState,
  parseKeyValueXml,
  parseBooleanFromText,
  truncateToCompleteSentence,
  logger,
} from "@elizaos/core";

import {
  multiStepDecisionTemplate,
  multiStepSummaryTemplate,
  shouldRespondTemplate,
  MULTISTEP_DECISION_SYSTEM,
} from "../templates/multi-step";
import {
  refreshStateAfterAction,
  getActionResultsFromCache,
} from "../utils/state";
import type {
  MultiStepActionResult,
  StrategyMode,
  StrategyResult,
  CloudMessageOptions,
  ParsedMultiStepDecision,
  StreamChunkCallback,
  ReasoningChunkCallback,
} from "../types";

const latestResponseIds = new Map<string, Map<string, string>>();

const RETRY_CONFIG = {
  baseDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
} as const;

const EMPTY_STATE: State = { values: {}, data: {}, text: "" } as State;

const SINGLE_SHOT_TEMPLATE = `<task>Generate a response for the character {{agentName}}.</task>

<providers>
{{providers}}
</providers>

<instructions>
Write a response for {{agentName}} based on the conversation.
Available actions: {{actionNames}}
</instructions>

<output>
Respond using XML format:
<response>
  <thought>Your reasoning here</thought>
  <actions>ACTION1,ACTION2 (or empty)</actions>
  <text>Your response text here</text>
</response>
</output>`;

function getRetryDelay(attempt: number): number {
  const delay =
    RETRY_CONFIG.baseDelayMs *
    Math.pow(RETRY_CONFIG.backoffMultiplier, attempt - 1);
  return Math.min(delay, RETRY_CONFIG.maxDelayMs);
}

/**
 * Clean up race tracking entry, but only if it still belongs to the given responseId.
 * This prevents a completed message A from deleting the tracking entry of a newer message B.
 */
function cleanupRaceTracking(
  agentId: string,
  roomId: string,
  responseId?: string,
): void {
  const agentResponses = latestResponseIds.get(agentId);
  if (!agentResponses) return;

  // If responseId provided, only delete if it still matches (ownership check)
  if (responseId) {
    const currentResponseId = agentResponses.get(roomId);
    if (currentResponseId !== responseId) {
      // A newer message has taken over - don't delete their entry
      return;
    }
  }

  agentResponses.delete(roomId);
  if (agentResponses.size === 0) {
    latestResponseIds.delete(agentId);
  }
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
        logger.debug(`[MultiStep] ${label} succeeded on attempt ${attempt}`);
        return result;
      }
      logger.warn(
        `[MultiStep] ${label} validation failed on attempt ${attempt}/${maxRetries}`,
      );
    } catch (error) {
      logger.error(
        `[MultiStep] ${label} error on attempt ${attempt}/${maxRetries}:`,
        error,
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
      if (!latestResponseIds.has(runtime.agentId)) {
        latestResponseIds.set(runtime.agentId, new Map<string, string>());
      }
      const agentResponses = latestResponseIds.get(runtime.agentId)!;
      const previousResponseId = agentResponses.get(message.roomId);
      if (previousResponseId) {
        logger.debug(
          `[CloudBootstrap] Updating response ID for room ${message.roomId}`,
        );
      }
      agentResponses.set(message.roomId, responseId);

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
      cleanupRaceTracking(runtime.agentId, message.roomId, responseId);

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
    const agentResponses = latestResponseIds.get(runtime.agentId)!;

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
    const agentUserState = await runtime.getParticipantUserState(
      message.roomId,
      runtime.agentId,
    );
    const defLlmOff = parseBooleanFromText(
      String(runtime.getSetting("BOOTSTRAP_DEFLLMOFF") ?? ""),
    );

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
      !message.content.text
        ?.toLowerCase()
        .includes(runtime.character.name.toLowerCase());
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
      logger.debug(
        `[CloudBootstrap] Processing ${message.content.attachments.length} attachments`,
      );
      message.content.attachments = await this.processAttachments(
        runtime,
        message.content.attachments,
      );
    }

    // Get room context for shouldRespond decision
    const room = await runtime.getRoom(message.roomId);

    // Extract mention context from message metadata
    const metadata = message.content.metadata as
      | Record<string, unknown>
      | undefined;
    const mentionContext: MentionContext | undefined = metadata
      ? {
          isMention: !!metadata.isMention,
          isReply: !!metadata.isReply,
          isThread: !!metadata.isThread,
          mentionType: metadata.mentionType as MentionContext["mentionType"],
        }
      : undefined;

    // Check if we should respond
    const respondDecision = this.shouldRespond(
      runtime,
      message,
      room ?? undefined,
      mentionContext,
    );
    logger.debug(
      `[CloudBootstrap] shouldRespond: ${respondDecision.shouldRespond} (${respondDecision.reason})`,
    );

    // Determine if we should respond, using LLM evaluation if needed
    let shouldRespondToMessage = true;

    if (respondDecision.skipEvaluation) {
      shouldRespondToMessage = respondDecision.shouldRespond;
    } else {
      // Need LLM evaluation
      const evalState = await runtime.composeState(
        message,
        ["RECENT_MESSAGES", "CHARACTER", "ENTITIES"],
        true,
      );

      const shouldRespondPrompt = composePromptFromState({
        state: evalState,
        template:
          runtime.character.templates?.shouldRespondTemplate ||
          shouldRespondTemplate,
      });

      // === LLM CALL LOG: shouldRespond ===
      logger.info("========== LLM CALL: shouldRespond ==========");
      logger.info(
        `[LLM:shouldRespond] System Prompt:\n${runtime.character.system || "(none)"}`,
      );
      logger.info(`[LLM:shouldRespond] User Prompt:\n${shouldRespondPrompt}`);
      logger.info("==============================================");

      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt: shouldRespondPrompt,
      });

      logger.info(`[LLM:shouldRespond] Response:\n${response}`);

      const responseObject = parseKeyValueXml(String(response));
      const nonResponseActions = ["IGNORE", "NONE", "STOP"];
      const actionValue = responseObject?.action;

      shouldRespondToMessage =
        typeof actionValue === "string" &&
        !nonResponseActions.includes(actionValue.toUpperCase());

      logger.debug(
        `[CloudBootstrap] LLM decided: ${shouldRespondToMessage ? "RESPOND" : "IGNORE"}`,
      );
    }

    if (!shouldRespondToMessage) {
      logger.debug(`[CloudBootstrap] Not responding based on evaluation`);
      await this.emitRunEnded(
        runtime,
        runId,
        message,
        startTime,
        "shouldRespond:no",
      );
      return {
        didRespond: false,
        responseContent: null,
        responseMessages: [],
        state: EMPTY_STATE,
        mode: "none",
      };
    }

    // Compose initial state
    let state = await runtime.composeState(
      message,
      ["ENTITIES", "CHARACTER", "RECENT_MESSAGES", "ACTIONS"],
      true,
    );

    // Determine processing mode - default to multi-step for cloud
    const useMultiStep =
      options?.useMultiStep ??
      parseBooleanFromText(
        String(runtime.getSetting("USE_MULTI_STEP") ?? "true"),
      );

    // Run appropriate processing strategy
    let result: StrategyResult;
    if (useMultiStep) {
      logger.debug("[CloudBootstrap] Using multi-step processing");
      result = await this.runMultiStepCore(
        runtime,
        message,
        state,
        callback,
        options,
      );
    } else {
      logger.debug("[CloudBootstrap] Using single-shot processing");
      result = await this.runSingleShotCore(
        runtime,
        message,
        state,
        callback,
        options,
      );
    }

    let responseContent = result.responseContent;
    const responseMessages = result.responseMessages;
    state = result.state;

    // Race check before sending response
    if (agentResponses.get(message.roomId) !== responseId) {
      logger.info(
        `[CloudBootstrap] Response discarded - newer message being processed`,
      );
      await this.emitRunEnded(
        runtime,
        runId,
        message,
        startTime,
        "race-discarded",
      );
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
      } else if (mode === "actions") {
        // Actions mode - run processActions (though in multi-step we already did this)
        await runtime.processActions(
          message,
          responseMessages,
          state,
          async (content) => {
            responseContent!.actionCallbacks = content;
            if (callback) {
              return callback(content);
            }
            return [];
          },
        );
      }
    }

    // Clean up response ID tracking (only if we still own it)
    cleanupRaceTracking(runtime.agentId, message.roomId, responseId);

    // Run evaluators
    await runtime.evaluate(
      message,
      state,
      true,
      async (content) => {
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
   * Multi-step execution: ONE action at a time, LLM decides next step.
   * Decision phase: functional system prompt. Summary phase: character personality.
   */
  private async runMultiStepCore(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    callback?: HandlerCallback,
    options?: CloudMessageOptions,
  ): Promise<StrategyResult> {
    const traceActionResult: MultiStepActionResult[] = [];
    let accumulatedState: State = state;

    const maxIterations =
      options?.maxMultiStepIterations ??
      parseInt(String(runtime.getSetting("MAX_MULTISTEP_ITERATIONS") ?? "6"));
    let iterationCount = 0;

    const originalSystemPrompt = runtime.character.system;

    // Wait for MCP service to finish initializing (registering tool actions)
    const mcpService = runtime.getService("mcp");
    if (mcpService && "waitForInitialization" in mcpService) {
      logger.debug("[MultiStep] Waiting for MCP service initialization...");
      await (
        mcpService as { waitForInitialization: () => Promise<void> }
      ).waitForInitialization();
      logger.debug("[MultiStep] MCP service ready");
    }

    accumulatedState = await runtime.composeState(
      message,
      [
        "RECENT_MESSAGES",
        "ACTION_STATE",
        "ACTIONS",
        "USER_AUTH_STATUS",
        // NOTE: "MCP" provider removed - MCP tools are now registered as native actions
        // via McpService.registerToolsAsActions() and appear in ACTIONS provider
      ],
      true,
    );
    accumulatedState.data.actionResults = traceActionResult;

    const streamThinking = async (
      phase: string,
      content: string,
    ): Promise<void> => {
      if (options?.onReasoningChunk) {
        await options.onReasoningChunk(
          content,
          phase as "planning" | "actions" | "response" | "thinking",
          message.id as UUID,
        );
      }
    };

    runtime.character.system = MULTISTEP_DECISION_SYSTEM;

    try {
      while (iterationCount < maxIterations) {
        iterationCount++;
        logger.debug(
          `[MultiStep] Starting iteration ${iterationCount}/${maxIterations}`,
        );

        await streamThinking(
          "thinking",
          `\n--- Step ${iterationCount}/${maxIterations} ---\n`,
        );

        // Inject actionResults into message metadata BEFORE composeState
        // so ACTION_STATE provider can read it during state composition
        const messageWithResults = {
          ...message,
          content: {
            ...message.content,
            metadata: {
              ...(message.content.metadata || {}),
              actionResults: traceActionResult,
            },
          },
        };

        accumulatedState = await runtime.composeState(
          messageWithResults,
          [
            "RECENT_MESSAGES",
            "ACTION_STATE",
            "ACTIONS",
            "USER_AUTH_STATUS",
            // NOTE: "MCP" provider removed - MCP tools are now native actions
          ],
          true,
        );
        // Also set on state.data for consistency
        accumulatedState.data.actionResults = traceActionResult;

        const stateWithIterationContext = {
          ...accumulatedState,
          iterationCount,
          maxIterations,
          traceActionResult,
        };

        const prompt = composePromptFromState({
          state: stateWithIterationContext,
          template:
            runtime.character.templates?.multiStepDecisionTemplate ||
            multiStepDecisionTemplate,
        });

        // === LLM CALL LOG: multiStepDecision ===
        logger.info(
          `========== LLM CALL: multiStepDecision (iteration ${iterationCount}/${maxIterations}) ==========`,
        );
        logger.info(
          `[LLM:multiStepDecision] System Prompt:\n${runtime.character.system}`,
        );
        logger.info(`[LLM:multiStepDecision] User Prompt:\n${prompt}`);
        logger.info("==============================================");

        const maxParseRetries = parseInt(
          String(runtime.getSetting("MULTISTEP_PARSE_RETRIES") ?? "5"),
        );
        let stepResultRaw = "";
        let parsedStep: ParsedMultiStepDecision | null = null;

        for (
          let parseAttempt = 1;
          parseAttempt <= maxParseRetries;
          parseAttempt++
        ) {
          try {
            logger.debug(
              `[MultiStep] Decision model call attempt ${parseAttempt}/${maxParseRetries}`,
            );

            stepResultRaw = await runtime.useModel(ModelType.TEXT_LARGE, {
              prompt,
            });

            logger.info(
              `[LLM:multiStepDecision] Response (attempt ${parseAttempt}):\n${stepResultRaw}`,
            );
            parsedStep = parseKeyValueXml(
              stepResultRaw,
            ) as ParsedMultiStepDecision | null;

            if (parsedStep) {
              logger.debug(
                `[MultiStep] Successfully parsed on attempt ${parseAttempt}`,
              );

              if (parsedStep.thought && options?.onReasoningChunk) {
                await streamThinking("planning", parsedStep.thought);
              }
              break;
            } else {
              logger.warn(
                `[MultiStep] Failed to parse XML on attempt ${parseAttempt}/${maxParseRetries}`,
              );
              if (parseAttempt < maxParseRetries) {
                const delay = getRetryDelay(parseAttempt);
                await new Promise((resolve) => setTimeout(resolve, delay));
              }
            }
          } catch (error) {
            logger.error(
              `[MultiStep] Error during model call attempt ${parseAttempt}:`,
              error,
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
            `[MultiStep] Failed to parse step result after ${maxParseRetries} attempts`,
          );
          traceActionResult.push({
            data: { actionName: "parse_error" },
            success: false,
            error: `Failed to parse step result after ${maxParseRetries} attempts`,
          });
          break;
        }

        const { thought, action, isFinish, parameters } = parsedStep;

        if (!action) {
          if (isFinish === "true" || isFinish === true) {
            logger.info(
              `[MultiStep] Task complete at iteration ${iterationCount}`,
            );
            await streamThinking("response", "\n--- Completing task ---\n");
            break;
          }
          logger.warn(
            `[MultiStep] No action at iteration ${iterationCount}, forcing completion`,
          );
          break;
        }

        try {
          if (!accumulatedState.data) accumulatedState.data = {};
          if (!accumulatedState.data.workingMemory)
            accumulatedState.data.workingMemory = {};

          let actionParams: Record<string, unknown> = {};
          if (parameters) {
            if (typeof parameters === "string") {
              try {
                actionParams = JSON.parse(parameters);
                logger.debug(
                  `[MultiStep] Parsed parameters: ${JSON.stringify(actionParams)}`,
                );
              } catch {
                logger.warn(
                  `[MultiStep] Failed to parse parameters JSON: ${parameters}`,
                );
              }
            } else if (typeof parameters === "object") {
              actionParams = parameters;
            }
          }

          const hasActionParams = Object.keys(actionParams).length > 0;

          if (action && hasActionParams) {
            accumulatedState.data.actionParams = actionParams;
            const actionKey = action.toLowerCase().replace(/_/g, "");
            accumulatedState.data[actionKey] = {
              ...actionParams,
              _source: "multiStepDecisionTemplate",
              _timestamp: Date.now(),
            };
            logger.info(
              `[MultiStep] Stored parameters for ${action}: ${JSON.stringify(actionParams)}`,
            );
          }

          await streamThinking(
            "actions",
            `\nExecuting action: ${action}${hasActionParams ? ` with params: ${JSON.stringify(actionParams)}` : ""}\n`,
          );

          const actionContent: Content & {
            actionParams?: Record<string, unknown>;
            actionInput?: Record<string, unknown>;
          } = {
            text: `Executing action: ${action}`,
            actions: [action],
            thought: thought ?? "",
          };

          if (hasActionParams) {
            actionContent.actionParams = actionParams;
            actionContent.actionInput = actionParams;
          }

          let capturedResult: {
            text?: string;
            success?: boolean;
            values?: Record<string, unknown>;
          } | null = null;

          await runtime.processActions(
            message,
            [
              {
                id: v4() as UUID,
                entityId: runtime.agentId,
                roomId: message.roomId,
                createdAt: Date.now(),
                content: actionContent,
              },
            ],
            accumulatedState,
            async (result) => {
              capturedResult = result;
              return [];
            },
          );

          const result =
            capturedResult ||
            (() => {
              const actionResults = getActionResultsFromCache(
                runtime,
                message.id as string,
              );
              return actionResults.length > 0
                ? (actionResults[0] as Record<string, unknown>)
                : null;
            })();
          const success = (result?.success as boolean) ?? false;

          const actionResult: MultiStepActionResult = {
            data: { actionName: action },
            success,
            text: result?.text as string | undefined,
            values: result?.values as Record<string, unknown> | undefined,
            error: success ? undefined : (result?.text as string | undefined),
          };
          traceActionResult.push(actionResult);

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
          const resultData = result?.data as
            | Record<string, unknown>
            | undefined;
          if (resultData?.awaitingUserInput === true) {
            logger.info(
              `[MultiStep] Action ${action} awaiting user input, pausing loop`,
            );
            break;
          }
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          logger.error(
            `[MultiStep] Error executing action ${action}: ${errorMessage}`,
          );
          traceActionResult.push({
            data: { actionName: action || "unknown" },
            success: false,
            error: errorMessage,
          });

          await streamThinking(
            "actions",
            `\nAction ${action} error: ${errorMessage}\n`,
          );
        }

        if (isFinish === "true" || isFinish === true) {
          logger.info(
            `[MultiStep] Task complete at iteration ${iterationCount}`,
          );
          break;
        }
      }

      if (iterationCount >= maxIterations) {
        logger.warn(
          `[MultiStep] Reached maximum iterations (${maxIterations})`,
        );
      }
    } finally {
      runtime.character.system = originalSystemPrompt;
    }

    await streamThinking("response", "\n--- Generating final response ---\n");

    // Inject actionResults into message metadata BEFORE composeState
    // so ACTION_STATE provider can read them during state composition
    const summaryMessageWithResults = {
      ...message,
      content: {
        ...message.content,
        metadata: {
          ...(message.content.metadata || {}),
          actionResults: traceActionResult,
        },
      },
    };

    accumulatedState = await runtime.composeState(
      summaryMessageWithResults,
      ["RECENT_MESSAGES", "ACTION_STATE", "CHARACTER", "USER_AUTH_STATUS"],
      true,
    );
    // Also set on state.data for consistency
    accumulatedState.data.actionResults = traceActionResult;

    const summaryPrompt = composePromptFromState({
      state: accumulatedState,
      template:
        runtime.character.templates?.multiStepSummaryTemplate ||
        multiStepSummaryTemplate,
    });

    // === LLM CALL LOG: multiStepSummary ===
    logger.info("========== LLM CALL: multiStepSummary ==========");
    logger.info(
      `[LLM:multiStepSummary] System Prompt:\n${runtime.character.system || "(none)"}`,
    );
    logger.info(`[LLM:multiStepSummary] User Prompt:\n${summaryPrompt}`);
    logger.info("==============================================");

    const maxSummaryRetries = parseInt(
      String(runtime.getSetting("MULTISTEP_SUMMARY_PARSE_RETRIES") ?? "5"),
    );
    let finalOutput = "";
    let summary: Record<string, unknown> | null = null;

    for (
      let summaryAttempt = 1;
      summaryAttempt <= maxSummaryRetries;
      summaryAttempt++
    ) {
      try {
        logger.debug(
          `[MultiStep] Summary generation attempt ${summaryAttempt}`,
        );
        finalOutput = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: summaryPrompt,
        });

        logger.info(
          `[LLM:multiStepSummary] Response (attempt ${summaryAttempt}):\n${finalOutput}`,
        );
        summary = parseKeyValueXml(finalOutput);

        if (summary?.text) {
          logger.debug(
            `[MultiStep] Parsed summary on attempt ${summaryAttempt}`,
          );
          break;
        } else {
          logger.warn(
            `[MultiStep] Failed to parse summary on attempt ${summaryAttempt}/${maxSummaryRetries}`,
          );
          if (summaryAttempt < maxSummaryRetries) {
            const delay = getRetryDelay(summaryAttempt);
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      } catch (error) {
        logger.error(
          `[MultiStep] Summary generation error on attempt ${summaryAttempt}:`,
          error,
        );
        if (summaryAttempt >= maxSummaryRetries) {
          logger.warn(
            "[MultiStep] Failed to generate summary after all retries",
          );
          break;
        }
        const delay = getRetryDelay(summaryAttempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    let responseContent: Content | null = null;
    if (summary?.text) {
      responseContent = {
        actions: ["MULTI_STEP_SUMMARY"],
        text: summary.text as string,
        thought:
          (summary.thought as string) ||
          "Final user-facing message after task completion.",
        simple: true,
      };

      if (options?.onStreamChunk) {
        await options.onStreamChunk(summary.text as string, message.id as UUID);
      }
    } else {
      logger.warn(`[MultiStep] No valid summary generated, using fallback`);
      const fallbackText =
        "I completed the requested actions, but encountered an issue generating the summary.";
      responseContent = {
        actions: ["MULTI_STEP_SUMMARY"],
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
  }

  private async runSingleShotCore(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    callback?: HandlerCallback,
    options?: CloudMessageOptions,
  ): Promise<StrategyResult> {
    const template =
      runtime.character.templates?.messageHandlerTemplate ||
      SINGLE_SHOT_TEMPLATE;
    const prompt = composePromptFromState({ state, template });

    logger.info("========== LLM CALL: singleShot ==========");
    logger.info(
      `[LLM:singleShot] System Prompt:\n${runtime.character.system || "(none)"}`,
    );
    logger.info(`[LLM:singleShot] User Prompt:\n${prompt}`);
    logger.info("==============================================");

    const maxRetries = options?.maxRetries ?? 3;
    const parsedResponse = await withRetry(
      async () => {
        const response = String(
          await runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
        );
        logger.info(`[LLM:singleShot] Response:\n${response}`);
        return parseKeyValueXml(response);
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

    const actions = parsedResponse.actions
      ? String(parsedResponse.actions)
          .split(",")
          .map((a: string) => a.trim())
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
      [
        ...alwaysRespondChannels.map((t) => t.toString()),
        ...customChannels,
      ].map((s) => s.trim().toLowerCase()),
    );

    const respondSources = [...alwaysRespondSources, ...customSources].map(
      (s) => s.trim().toLowerCase(),
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
    const hasPlatformMention = !!(
      mentionContext?.isMention || mentionContext?.isReply
    );
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

  async processAttachments(
    runtime: IAgentRuntime,
    attachments: Media[],
  ): Promise<Media[]> {
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
                : (result as { description?: string })?.description ||
                  "Image attachment";
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
      logger.error(
        "[CloudBootstrap] Cannot delete memory: message ID is missing",
      );
      return;
    }

    logger.info(
      `[CloudBootstrap] Deleting memory for message ${message.id} from room ${message.roomId}`,
    );
    await runtime.deleteMemory(message.id);
  }

  async clearChannel(
    runtime: IAgentRuntime,
    roomId: UUID,
    channelId: string,
  ): Promise<void> {
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
          logger.warn(
            `[CloudBootstrap] Failed to delete memory ${memory.id}: ${error}`,
          );
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
