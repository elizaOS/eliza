import {
  asUUID,
  composePromptFromState,
  type Content,
  ContentType,
  createUniqueUuid,
  EventType,
  logger,
  type Media,
  type Memory,
  parseKeyValueXml,
  type UUID,
} from "@elizaos/core";
import { v4 } from "uuid";
import {
  chatAssistantSystemPrompt,
  chatAssistantPlanningTemplate,
  chatAssistantFinalSystemPrompt,
  chatAssistantResponseTemplate,
} from "./prompts/chat-assistant-prompts";
import {
  setLatestResponseId,
  clearLatestResponseId,
  isResponseStillValid,
} from "../shared/utils/response-tracking";
import {
  generateResponseWithRetry,
  generatePlanningWithStreaming,
  runEvaluatorsWithTimeout,
  extractAttachments,
  getAndClearCachedAttachments,
  executeProviders,
  executeActions,
  cleanPrompt,
} from "../shared/utils/helpers";
import {
  parsePlannedItems,
  canRespondImmediately,
  type ParsedPlan,
} from "../shared/utils/parsers";
import type {
  MessageReceivedHandlerParams,
  RunEndedEventPayload,
} from "../shared/types";

/**
 * Chat Assistant Workflow Handler - planning-based with action execution.
 */
export async function handleMessage({
  runtime,
  message,
  callback,
  onStreamChunk,
  onReasoningChunk,
}: MessageReceivedHandlerParams): Promise<void> {
  const responseId = v4();
  const runId = asUUID(v4());
  const startTime = Date.now();

  if (message.entityId === runtime.agentId) {
    throw new Error("Message is from the agent itself");
  }

  setLatestResponseId(runtime, message.roomId, responseId).catch((e) => {
    logger.warn(`[ChatAssistant] Failed to set response ID: ${e}`);
  });

  runtime
    .emitEvent(EventType.RUN_STARTED, {
      runtime,
      runId,
      messageId: message.id || asUUID(v4()),
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: "started",
      source: "chatAssistantWorkflow",
    })
    .catch((e) =>
      logger.debug(`[ChatAssistant] RUN_STARTED emit failed: ${e}`),
    );

  const initialState = await runtime.composeState(message, [
    "SUMMARIZED_CONTEXT",
    "RECENT_MESSAGES",
    "LONG_TERM_MEMORY",
    "AVAILABLE_DOCUMENTS",
    "PROVIDERS",
    "MCP",
    "ACTIONS",
    "CHARACTER",
    "CURRENT_RUN_CONTEXT",
  ]);

  const originalSystemPrompt = runtime.character.system;

  try {
    runtime.createMemory(message, "messages").catch((e) => {
      logger.warn(`[ChatAssistant] Failed to save user message: ${e}`);
    });

    const planningPrompt = cleanPrompt(
      composePromptFromState({
        state: initialState,
        template:
          runtime.character.templates?.planningTemplate ||
          chatAssistantPlanningTemplate,
      }),
    );

    runtime.character.system = composePromptFromState({
      state: initialState,
      template: chatAssistantSystemPrompt,
    });

    const planningResponse = await generatePlanningWithStreaming(
      runtime,
      planningPrompt,
      onReasoningChunk
        ? { onReasoningChunk, messageId: responseId as UUID }
        : undefined,
    );

    const plan = parseKeyValueXml(planningResponse) as ParsedPlan | null;
    const shouldRespondNow = canRespondImmediately(plan);

    let responseContent = "";
    let thought = plan?.thought || "";

    if (shouldRespondNow && plan?.text) {
      responseContent = plan.text;
      if (onStreamChunk) {
        const chunkSize = 20;
        for (let i = 0; i < responseContent.length; i += chunkSize) {
          await onStreamChunk(
            responseContent.slice(i, i + chunkSize),
            responseId as UUID,
          );
        }
      }
    } else {
      let updatedState = { ...initialState };

      if (!shouldRespondNow) {
        const plannedProviders = parsePlannedItems(plan?.providers);
        const plannedActions = parsePlannedItems(plan?.actions);

        updatedState = await executeProviders(
          runtime,
          message,
          plannedProviders,
          updatedState,
        );

        updatedState = await executeActions(
          runtime,
          message,
          plannedActions,
          plan,
          updatedState,
        );
      }

      if (thought) {
        updatedState.planningThought = `# Planning Reasoning\n${thought}`;
      } else {
        updatedState.planningThought = "";
      }

      runtime.character.system = cleanPrompt(
        composePromptFromState({
          state: updatedState,
          template: chatAssistantFinalSystemPrompt,
        }),
      );

      const responsePrompt = cleanPrompt(
        composePromptFromState({
          state: updatedState,
          template:
            runtime.character.templates?.messageHandlerTemplate ||
            chatAssistantResponseTemplate,
        }),
      );

      const responseResult = await generateResponseWithRetry(
        runtime,
        responsePrompt,
        onStreamChunk
          ? {
              onStreamChunk,
              onReasoningChunk,
              messageId: responseId as UUID,
            }
          : undefined,
      );
      responseContent = responseResult.text;
      thought = responseResult.thought;
    }

    if (!(await isResponseStillValid(runtime, message.roomId, responseId))) {
      logger.info(`[ChatAssistant] Response discarded - superseded`);
      return;
    }

    await clearLatestResponseId(runtime, message.roomId);

    const actionResults = await runtime.getActionResults(message.id as UUID);
    const actionResultAttachments = extractAttachments(actionResults);
    const cachedAttachments = getAndClearCachedAttachments(
      message.roomId as string,
    );

    const attachmentMap = new Map<
      string,
      { id: string; url: string; title?: string; contentType?: string }
    >();
    for (const att of [...actionResultAttachments, ...cachedAttachments]) {
      if (att && typeof att === "object" && "id" in att && "url" in att) {
        const { id, url, title, contentType } = att as {
          id?: string;
          url?: string;
          title?: string;
          contentType?: string;
        };
        if (id && url) attachmentMap.set(id, { id, url, title, contentType });
      }
    }

    const mediaAttachments: Media[] = Array.from(attachmentMap.values())
      .filter((att) => att.url.length > 0)
      .map((att) => {
        const contentType =
          att.contentType?.toUpperCase() as keyof typeof ContentType;
        return {
          id: att.id,
          url: att.url,
          ...(att.title && { title: att.title }),
          ...(contentType &&
            ContentType[contentType] && {
              contentType: ContentType[contentType],
            }),
        };
      });

    const content: Content = {
      text: responseContent,
      thought,
      source: "agent",
      inReplyTo: message.id,
      ...(mediaAttachments.length > 0 && { attachments: mediaAttachments }),
    };

    if (callback) {
      await callback(content);
    }

    const responseMemory: Memory = {
      id: createUniqueUuid(runtime, (message.id ?? v4()) as UUID),
      entityId: runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content,
    };

    runEvaluatorsWithTimeout(
      runtime,
      message,
      initialState,
      responseMemory,
      callback,
    ).catch((e) => {
      logger.warn(`[ChatAssistant] Evaluators failed: ${e}`);
    });

    const endTime = Date.now();
    logger.info(`[ChatAssistant] ${endTime - startTime}ms`);

    runtime
      .emitEvent(EventType.RUN_ENDED, {
        runtime,
        runId,
        messageId: message.id || asUUID(v4()),
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: "completed",
        endTime,
        duration: endTime - startTime,
        source: "chatAssistantWorkflow",
      })
      .catch((e) =>
        logger.debug(`[ChatAssistant] RUN_ENDED emit failed: ${e}`),
      );
  } catch (error) {
    const errorPayload: RunEndedEventPayload = {
      runtime,
      runId,
      messageId: (message.id || asUUID(v4())) as UUID,
      roomId: message.roomId as UUID,
      entityId: message.entityId as UUID,
      startTime,
      status: "error",
      endTime: Date.now(),
      duration: Date.now() - startTime,
      error: error instanceof Error ? error.message : String(error),
      source: "chatAssistantWorkflow",
    };
    await runtime.emitEvent(EventType.RUN_ENDED, errorPayload as never);
    throw error;
  } finally {
    // Always restore original system prompt, even on early returns or errors
    runtime.character.system = originalSystemPrompt;
  }
}
