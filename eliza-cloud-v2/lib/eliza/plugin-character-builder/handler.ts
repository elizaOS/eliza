import {
  asUUID,
  composePromptFromState,
  createUniqueUuid,
  EventType,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type UUID,
} from "@elizaos/core";
import { v4 } from "uuid";
import {
  setLatestResponseId,
  clearLatestResponseId,
  isResponseStillValid,
} from "../shared/utils/response-tracking";
import {
  buildModeSystemPrompt,
  buildModePlanningTemplate,
} from "./prompts/build-mode-prompts";
import { parsePlannedItems } from "../shared/utils/parsers";
import {
  cleanPrompt,
  runEvaluatorsWithTimeout,
  isCreatorMode,
  DEFAULT_ELIZA_ID,
} from "../shared/utils/helpers";
import type { MessageReceivedHandlerParams } from "../shared/types";

function parsePlanningResponse(
  response: string,
): { thought: string; actions: string } | null {
  const parsed = parseKeyValueXml(response) as {
    thought?: string;
    actions?: string;
  } | null;
  if (!parsed?.actions) return null;
  return { thought: parsed.thought || "", actions: parsed.actions };
}

/**
 * Build mode handler for character creation/editing.
 *
 * Two distinct flows:
 * - Creator Mode: runtime.character.id === DEFAULT_ELIZA_ID (building new character)
 * - Build Mode: runtime.character.id !== DEFAULT_ELIZA_ID (editing existing character)
 */
export async function handleMessage({
  runtime,
  message,
  callback,
  onStreamChunk,
}: MessageReceivedHandlerParams): Promise<void> {
  const responseId = v4();
  const runId = asUUID(v4());
  const startTime = Date.now();
  const originalSystemPrompt = runtime.character.system;

  if (message.entityId === runtime.agentId) {
    throw new Error("Message is from the agent itself");
  }

  if (!message.id) {
    throw new Error("Message must have an id");
  }

  const messageId = message.id;
  const creatorMode = isCreatorMode(runtime);
  const modeLabel = creatorMode ? "Creator" : "Build";
  const sourceLabel = creatorMode ? "build-mode-Creator" : "build-mode-Build";

  logger.info(`[${modeLabel}] Processing message in room ${message.roomId}`);

  await setLatestResponseId(runtime, message.roomId, responseId);
  await runtime.emitEvent(EventType.RUN_STARTED, {
    runtime,
    runId,
    messageId,
    roomId: message.roomId,
    entityId: message.entityId,
    startTime,
    status: "started",
    source: sourceLabel,
  });

  try {
    await runtime.createMemory(message, "messages");

    // Compose state with all providers including actions and current character
    const state = await runtime.composeState(message, [
      "SUMMARIZED_CONTEXT",
      "RECENT_MESSAGES",
      "LONG_TERM_MEMORY",
      "ACTIONS",
      "CURRENT_CHARACTER",
    ]);

    // Inject mode context for planning phase
    state.values = {
      ...state.values,
      isCreatorMode: creatorMode,
      modeLabel,
      characterId: runtime.character.id || DEFAULT_ELIZA_ID,
      characterName: runtime.character.name,
    };

    // Planning phase - let the model decide the best action
    runtime.character.system = cleanPrompt(
      composePromptFromState({ state, template: buildModeSystemPrompt }),
    );

    const planningPrompt = cleanPrompt(
      composePromptFromState({ state, template: buildModePlanningTemplate }),
    );

    const planningResponse = await runtime.useModel(ModelType.TEXT_LARGE, {
      prompt: planningPrompt,
    });

    runtime.character.system = originalSystemPrompt;

    const plan = parsePlanningResponse(planningResponse);
    const selectedAction =
      parsePlannedItems(plan?.actions)[0] || "BUILDER_CHAT";

    // Create action response with thought and mode context
    const actionResponse: Memory = {
      id: createUniqueUuid(runtime, v4() as UUID),
      entityId: runtime.agentId,
      agentId: runtime.agentId,
      roomId: message.roomId,
      worldId: message.worldId,
      content: {
        thought: plan?.thought,
        actions: [selectedAction],
        source: "agent",
        metadata: {
          isCreatorMode: creatorMode,
          modeLabel,
        },
      },
    };

    // Add planning thought to state for action access
    state.values = {
      ...state.values,
      planningThought: plan?.thought || "",
    };

    await runtime.processActions(
      message,
      [actionResponse],
      state,
      callback,
      onStreamChunk ? { onStreamChunk } : undefined,
    );

    if (!(await isResponseStillValid(runtime, message.roomId, responseId)))
      return;
    await clearLatestResponseId(runtime, message.roomId);

    // Run evaluators asynchronously in background
    await runEvaluatorsWithTimeout(
      runtime,
      message,
      state,
      actionResponse,
      callback,
    );

    const endTime = Date.now();
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      runId,
      messageId,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: "completed",
      endTime,
      duration: endTime - startTime,
      source: sourceLabel,
    });
  } catch (error) {
    runtime.character.system = originalSystemPrompt;
    const endTime = Date.now();
    // @ts-expect-error - RUN_ENDED status should include "error" for proper analytics tracking
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      runId,
      messageId,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: "error",
      endTime,
      duration: endTime - startTime,
      error: error instanceof Error ? error.message : String(error),
      source: sourceLabel,
    });
    throw error;
  }
}
