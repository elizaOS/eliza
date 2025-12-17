import { v4 } from 'uuid';
import type { IAgentRuntime } from '../types/runtime';
import type { Memory } from '../types/memory';
import type { Content, UUID } from '../types/primitives';
import type { State } from '../types/state';
import type { HandlerCallback } from '../types/components';
import {
  type IMessageService,
  type MessageProcessingOptions,
  type MessageProcessingResult,
} from './message-service';
import {
  EventType,
  ModelType,
  asUUID,
  createUniqueUuid,
  composePromptFromState,
  parseKeyValueXml,
  type RunEventPayload,
} from '../index';

/**
 * Parsed response from LLM
 */
interface ParsedResponse {
  thought?: string;
  text?: string;
}

/**
 * Default system prompt template for single-shot responses
 */
const defaultSystemPrompt = `
# Character Identity
{{system}}
{{bio}}
{{messageDirections}}
{{characterLore}}

<instructions>
Respond to the user's message using your persona and character identity.
</instructions>

<output>
Respond using XML format like this:
<response>
  <thought>
    1. Your internal reasoning about how to respond
    2. Analysis: Should I ask a follow-up question? Why or why not?
  </thought>
  <text>Your response text here (may or may not end with a question based on your reasoning)</text>
</response>

Your response must ONLY include the <response></response> XML block.
</output>
`;

/**
 * Default template for composing the user prompt
 */
const defaultTemplate = `
{{sessionSummaries}}
{{longTermMemories}}
{{conversationLog}}
{{receivedMessageHeader}}
`;

/**
 * Single-shot message service implementation.
 *
 * This service provides a simplified message handling approach:
 * - Single LLM call without complex planning or action execution
 * - Basic state composition with memory providers
 * - Immediate response without multi-step workflows
 * - Background evaluator execution
 *
 * This is ideal for:
 * - Simple conversational interactions
 * - Fast response times
 * - When you don't need complex action planning
 *
 * To use this service, set it on the runtime after initialization:
 * ```typescript
 * const messageService = new SingleShotMessageService();
 * runtime.messageService = messageService;
 * ```
 */
export class SingleShotMessageService implements IMessageService {
  /**
   * Main message handling entry point
   */
  async handleMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
    options?: MessageProcessingOptions
  ): Promise<MessageProcessingResult> {
    const responseId = v4();
    const runId = asUUID(v4());
    const startTime = Date.now();

    runtime.logger.info(
      `[SingleShotMessageService] Message received from ${message.entityId} in room ${message.roomId}`
    );
    runtime.logger.debug(`[SingleShotMessageService] Response ID: ${responseId.substring(0, 8)}`);
    runtime.logger.debug(`[SingleShotMessageService] Run ID: ${runId.substring(0, 8)}`);

    try {
      // Start run tracking
      await runtime.emitEvent(EventType.RUN_STARTED, {
        runtime,
        source: 'messageHandler',
        runId,
        messageId: message.id as UUID,
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: 'started',
      } as RunEventPayload);

      // Skip messages from self
      if (message.entityId === runtime.agentId) {
        runtime.logger.debug(
          `[SingleShotMessageService] Skipping message from self (${runtime.agentId})`
        );
        await this.emitRunEnded(runtime, runId, message, startTime, 'self');
        return {
          didRespond: false,
          responseContent: null,
          responseMessages: [],
          state: {} as State,
          mode: 'none',
        };
      }

      // Save the incoming message
      runtime.logger.debug('[SingleShotMessageService] Saving message to memory');
      let memoryId: UUID;

      if (message.id) {
        const existingMemory = await runtime.getMemoryById(message.id);
        if (!existingMemory) {
          memoryId = await runtime.createMemory(message, 'messages');
        } else {
          memoryId = message.id;
        }
      } else {
        memoryId = await runtime.createMemory(message, 'messages');
        message.id = memoryId;
      }

      // Compose state with basic providers (no actions, no dynamic providers)
      runtime.logger.info(
        `[SingleShotMessageService] Processing message for character: ${runtime.character.name} (ID: ${runtime.character.id})`
      );
      runtime.logger.debug('[SingleShotMessageService] Composing state with basic providers');
      const state = await runtime.composeState(message, [
        'RECENT_CONVERSATION_SUMMARY', // Conversation history + current message
        'LONG_TERM_MEMORY', // User facts and knowledge
        'CHARACTER',
        'CHARACTER_LORE',
      ]);

      // Compose system prompt
      const originalSystemPrompt = runtime.character.system;
      const composedSystemPrompt = composePromptFromState({
        state,
        template: defaultSystemPrompt,
      });
      runtime.character.system = composedSystemPrompt;

      // Compose user prompt
      const prompt = composePromptFromState({
        state,
        template: runtime.character.templates?.defaultTemplate || defaultTemplate,
      });

      runtime.logger.debug('[SingleShotMessageService] System prompt:\n', runtime.character.system);
      runtime.logger.debug('[SingleShotMessageService] User prompt:\n', prompt);

      // Single LLM call to get response
      const response = await runtime.useModel(ModelType.TEXT_LARGE, { prompt });
      runtime.logger.debug('[SingleShotMessageService] Raw LLM response:\n', response);

      const parsedResponse = parseKeyValueXml(response) as ParsedResponse | null;

      if (!parsedResponse?.text) {
        runtime.logger.error('[SingleShotMessageService] Failed to generate valid response');
        // Restore original system prompt
        runtime.character.system = originalSystemPrompt;

        await this.emitRunEnded(runtime, runId, message, startTime, 'error');
        return {
          didRespond: false,
          responseContent: null,
          responseMessages: [],
          state,
          mode: 'none',
        };
      }

      const responseContent: Content = {
        text: parsedResponse.text,
        thought: parsedResponse.thought || '',
        source: 'agent',
        inReplyTo: message.id ? createUniqueUuid(runtime, message.id) : undefined,
        simple: true,
      };

      // Restore original system prompt
      runtime.character.system = originalSystemPrompt;

      // Create response memory
      const responseMemory: Memory = {
        id: createUniqueUuid(runtime, (message.id ?? v4()) as UUID),
        entityId: runtime.agentId,
        agentId: runtime.agentId,
        roomId: message.roomId,
        worldId: message.worldId,
        content: responseContent,
        createdAt: Date.now(),
      };

      // Trigger callback immediately with response (don't wait for evaluators)
      if (callback) {
        runtime.logger.debug('[SingleShotMessageService] Invoking callback with response');
        await callback(responseContent);
      }

      // Run evaluators asynchronously in background
      this.runEvaluatorsInBackground(runtime, message, state, responseMemory, callback);

      runtime.logger.info(
        `[SingleShotMessageService] Run ${runId.substring(0, 8)} completed successfully`
      );

      // Emit run ended event
      const endTime = Date.now();
      await runtime.emitEvent(EventType.RUN_ENDED, {
        runtime,
        source: 'messageHandler',
        runId,
        messageId: message.id as UUID,
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: 'completed',
        endTime,
        duration: endTime - startTime,
      } as RunEventPayload);

      return {
        didRespond: true,
        responseContent,
        responseMessages: [responseMemory],
        state,
        mode: 'simple',
      };
    } catch (error: any) {
      runtime.logger.error({ error }, '[SingleShotMessageService] Error in handleMessage:');

      // Emit run ended event with error
      await runtime.emitEvent(EventType.RUN_ENDED, {
        runtime,
        source: 'messageHandler',
        runId,
        messageId: message.id as UUID,
        roomId: message.roomId,
        entityId: message.entityId,
        startTime,
        status: 'completed',
        endTime: Date.now(),
        duration: Date.now() - startTime,
        error: error.message,
      } as RunEventPayload);

      throw error;
    }
  }

  /**
   * Run evaluators with timeout to prevent hanging
   * Executes in background without blocking the response
   */
  private runEvaluatorsInBackground(
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    responseMemory: Memory,
    callback?: HandlerCallback
  ): void {
    // Run in background (fire and forget)
    (async () => {
      if (typeof runtime.evaluate !== 'function') {
        runtime.logger.debug(
          '[SingleShotMessageService] runtime.evaluate not available - skipping evaluators'
        );
        return;
      }

      runtime.logger.debug('[SingleShotMessageService] Running evaluators in background');

      try {
        const timeoutMs = 120000; // 2 minutes

        await Promise.race([
          runtime.evaluate(
            message,
            { ...state },
            true, // shouldRespondToMessage
            async (content) => {
              runtime.logger.debug(
                '[SingleShotMessageService] Evaluator callback:',
                JSON.stringify(content)
              );
              return callback ? callback(content) : [];
            },
            [responseMemory]
          ),
          new Promise<void>((_, reject) => {
            setTimeout(() => {
              reject(new Error(`Evaluators timed out after ${timeoutMs}ms`));
            }, timeoutMs);
          }),
        ]);

        runtime.logger.debug('[SingleShotMessageService] Evaluators completed successfully');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        runtime.logger.error(`[SingleShotMessageService] Error in evaluators: ${errorMessage}`);
      }
    })();
  }

  /**
   * Helper to emit run ended events
   */
  private async emitRunEnded(
    runtime: IAgentRuntime,
    runId: UUID,
    message: Memory,
    startTime: number,
    status: string
  ): Promise<void> {
    await runtime.emitEvent(EventType.RUN_ENDED, {
      runtime,
      source: 'messageHandler',
      runId,
      messageId: message.id as UUID,
      roomId: message.roomId,
      entityId: message.entityId,
      startTime,
      status: status as 'completed' | 'timeout',
      endTime: Date.now(),
      duration: Date.now() - startTime,
    } as RunEventPayload);
  }

  /**
   * Simplified shouldRespond logic for single-shot service.
   * Always responds unless it's a message from self.
   *
   * For more complex shouldRespond logic with LLM evaluation,
   * use the DefaultMessageService instead.
   */
  shouldRespond(
    runtime: IAgentRuntime,
    message: Memory
  ): { shouldRespond: boolean; skipEvaluation: boolean; reason: string } {
    // Never respond to self
    if (message.entityId === runtime.agentId) {
      return {
        shouldRespond: false,
        skipEvaluation: true,
        reason: 'message from self',
      };
    }

    // Always respond to all other messages
    return {
      shouldRespond: true,
      skipEvaluation: true,
      reason: 'single-shot mode always responds',
    };
  }

  /**
   * Deletes a message from the agent's memory.
   * Same implementation as DefaultMessageService for compatibility.
   */
  async deleteMessage(runtime: IAgentRuntime, message: Memory): Promise<void> {
    try {
      if (!message.id) {
        runtime.logger.error(
          '[SingleShotMessageService] Cannot delete memory: message ID is missing'
        );
        return;
      }

      runtime.logger.info(
        '[SingleShotMessageService] Deleting memory for message',
        message.id,
        'from room',
        message.roomId
      );
      await runtime.deleteMemory(message.id);
      runtime.logger.debug(
        { messageId: message.id },
        '[SingleShotMessageService] Successfully deleted memory for message'
      );
    } catch (error: unknown) {
      runtime.logger.error({ error }, '[SingleShotMessageService] Error in deleteMessage:');
      throw error;
    }
  }

  /**
   * Clears all messages from a channel/room.
   * Same implementation as DefaultMessageService for compatibility.
   */
  async clearChannel(runtime: IAgentRuntime, roomId: UUID, channelId: string): Promise<void> {
    try {
      runtime.logger.info(
        `[SingleShotMessageService] Clearing message memories from channel ${channelId} -> room ${roomId}`
      );

      // Get all message memories for this room
      const memories = await runtime.getMemoriesByRoomIds({
        tableName: 'messages',
        roomIds: [roomId],
      });

      runtime.logger.info(
        `[SingleShotMessageService] Found ${memories.length} message memories to delete from channel ${channelId}`
      );

      // Delete each message memory
      let deletedCount = 0;
      for (const memory of memories) {
        if (memory.id) {
          try {
            await runtime.deleteMemory(memory.id);
            deletedCount++;
          } catch (error) {
            runtime.logger.warn(
              { error, memoryId: memory.id },
              `[SingleShotMessageService] Failed to delete message memory ${memory.id}:`
            );
          }
        }
      }

      runtime.logger.info(
        `[SingleShotMessageService] Successfully cleared ${deletedCount}/${memories.length} message memories from channel ${channelId}`
      );
    } catch (error: unknown) {
      runtime.logger.error({ error }, '[SingleShotMessageService] Error in clearChannel:');
      throw error;
    }
  }
}
