import type { IAgentRuntime } from '../types/runtime';
import type { Memory } from '../types/memory';
import type { UUID, Media, MentionContext } from '../types/primitives';
import type { HandlerCallback } from '../types/components';
import type { Room } from '../types/environment';
import { type IMessageService, type MessageProcessingOptions, type MessageProcessingResult, type ResponseDecision } from './message-service';
/**
 * Default implementation of the MessageService interface.
 * This service handles the complete message processing pipeline including:
 * - Message validation and memory creation
 * - Smart response decision (shouldRespond)
 * - Single-shot or multi-step processing strategies
 * - Action execution and evaluation
 * - Attachment processing
 * - Message deletion and channel clearing
 *
 * This is the standard message handler used by ElizaOS and can be replaced
 * with custom implementations via the IMessageService interface.
 */
export declare class DefaultMessageService implements IMessageService {
    /**
     * Main message handling entry point
     */
    handleMessage(runtime: IAgentRuntime, message: Memory, callback?: HandlerCallback, options?: MessageProcessingOptions): Promise<MessageProcessingResult>;
    /**
     * Internal message processing implementation
     */
    private processMessage;
    /**
     * Determines whether the agent should respond to a message.
     * Uses simple rules for obvious cases (DM, mentions) and defers to LLM for ambiguous cases.
     */
    shouldRespond(runtime: IAgentRuntime, message: Memory, room?: Room, mentionContext?: MentionContext): ResponseDecision;
    /**
     * Processes attachments by generating descriptions for supported media types.
     */
    processAttachments(runtime: IAgentRuntime, attachments: Media[]): Promise<Media[]>;
    /**
     * Single-shot strategy: one LLM call to generate response
     */
    private runSingleShotCore;
    /**
     * Multi-step strategy: iterative action execution with final summary
     */
    private runMultiStepCore;
    /**
     * Helper to emit run ended events
     */
    private emitRunEnded;
    /**
     * Deletes a message from the agent's memory.
     * This method handles the actual deletion logic that was previously in event handlers.
     *
     * @param runtime - The agent runtime instance
     * @param message - The message memory to delete
     * @returns Promise resolving when deletion is complete
     */
    deleteMessage(runtime: IAgentRuntime, message: Memory): Promise<void>;
    /**
     * Clears all messages from a channel/room.
     * This method handles bulk deletion of all message memories in a room.
     *
     * @param runtime - The agent runtime instance
     * @param roomId - The room ID to clear messages from
     * @param channelId - The original channel ID (for logging)
     * @returns Promise resolving when channel is cleared
     */
    clearChannel(runtime: IAgentRuntime, roomId: UUID, channelId: string): Promise<void>;
}
//# sourceMappingURL=default-message-service.d.ts.map