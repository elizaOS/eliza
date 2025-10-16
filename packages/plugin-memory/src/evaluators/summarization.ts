import {
  type IAgentRuntime,
  type Memory,
  type Evaluator,
  type UUID,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { MemoryService } from '../services/memory-service';
import type { SummaryResult } from '../types/index';

/**
 * Template for generating conversation summaries
 */
const summarizationTemplate = `# Task: Summarize Conversation

You are analyzing a conversation to create a concise summary that captures the key points, topics, and important details.

# Recent Messages
{{recentMessages}}

# Instructions
Generate a summary that:
1. Captures the main topics discussed
2. Highlights key information shared
3. Notes any decisions made or questions asked
4. Maintains context for future reference
5. Is concise but comprehensive (2-4 paragraphs max)

Also extract:
- **Topics**: List of main topics discussed (comma-separated)
- **Key Points**: Important facts or decisions (bullet points)

Respond in this XML format:
<summary>
  <text>Your comprehensive summary here</text>
  <topics>topic1, topic2, topic3</topics>
  <keyPoints>
    <point>First key point</point>
    <point>Second key point</point>
  </keyPoints>
</summary>`;

/**
 * Parse XML summary response
 */
function parseSummaryXML(xml: string): SummaryResult {
  const summaryMatch = xml.match(/<text>([\s\S]*?)<\/text>/);
  const topicsMatch = xml.match(/<topics>([\s\S]*?)<\/topics>/);
  const keyPointsMatches = xml.matchAll(/<point>([\s\S]*?)<\/point>/g);

  const summary = summaryMatch ? summaryMatch[1].trim() : 'Summary not available';
  const topics = topicsMatch
    ? topicsMatch[1]
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const keyPoints = Array.from(keyPointsMatches).map((match) => match[1].trim());

  return { summary, topics, keyPoints };
}

/**
 * Short-term Memory Summarization Evaluator
 *
 * Monitors conversation length and generates summaries when threshold is reached.
 * Summaries replace older messages to reduce context size while preserving information.
 */
export const summarizationEvaluator: Evaluator = {
  name: 'MEMORY_SUMMARIZATION',
  description: 'Summarizes conversations to optimize short-term memory',
  similes: ['CONVERSATION_SUMMARY', 'CONTEXT_COMPRESSION', 'MEMORY_OPTIMIZATION'],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    // Only run after messages (not on agent's own messages during generation)
    if (!message.content?.text) {
      return false;
    }

    const memoryService = runtime.getService('memory') as MemoryService | null;
    if (!memoryService) {
      return false;
    }

    // Check if summarization is needed for this room
    return memoryService.shouldSummarize(message.roomId);
  },

  handler: async (runtime: IAgentRuntime, message: Memory): Promise<void> => {
    const memoryService = runtime.getService('memory') as MemoryService;
    if (!memoryService) {
      logger.error('MemoryService not found');
      return;
    }

    const config = memoryService.getConfig();
    const { roomId } = message;

    try {
      logger.info(`Starting summarization for room ${roomId}`);

      // Get messages to summarize (all but the most recent N)
      const allMessages = await runtime.getMemories({
        tableName: 'messages',
        roomId,
        count: config.shortTermSummarizationThreshold,
        unique: false,
      });

      if (allMessages.length < config.shortTermSummarizationThreshold) {
        logger.debug('Not enough messages to summarize yet');
        return;
      }

      // Sort by timestamp
      const sortedMessages = allMessages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

      // Split into messages to summarize and messages to keep
      const messagesToSummarize = sortedMessages.slice(
        0,
        sortedMessages.length - config.shortTermRetainRecent
      );
      const messagesToKeep = sortedMessages.slice(-config.shortTermRetainRecent);

      if (messagesToSummarize.length === 0) {
        logger.debug('No messages to summarize');
        return;
      }

      // Format messages for summarization
      const formattedMessages = messagesToSummarize
        .map((msg) => {
          const sender = msg.entityId === runtime.agentId ? runtime.character.name : 'User';
          return `${sender}: ${msg.content.text || '[non-text message]'}`;
        })
        .join('\n');

      // Generate summary using LLM
      const state = await runtime.composeState(message);
      const prompt = composePromptFromState({
        state: {
          ...state,
          recentMessages: formattedMessages,
        },
        template: summarizationTemplate,
      });

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      const summaryResult = parseSummaryXML(response);

      logger.info(`Generated summary: ${summaryResult.summary.substring(0, 100)}...`);

      // Store the summary
      const startTime = messagesToSummarize[0].createdAt
        ? new Date(messagesToSummarize[0].createdAt)
        : new Date();
      const endTime = messagesToSummarize[messagesToSummarize.length - 1].createdAt
        ? new Date(messagesToSummarize[messagesToSummarize.length - 1].createdAt)
        : new Date();

      await memoryService.storeSessionSummary({
        agentId: runtime.agentId,
        roomId,
        entityId: message.entityId !== runtime.agentId ? message.entityId : undefined,
        summary: summaryResult.summary,
        messageCount: messagesToSummarize.length,
        startTime,
        endTime,
        topics: summaryResult.topics,
        metadata: {
          keyPoints: summaryResult.keyPoints,
        },
      });

      // Delete summarized messages (keep recent ones)
      // Only delete messages that were actually summarized
      const db = await runtime.getConnection();
      if (db) {
        for (const msg of messagesToSummarize) {
          if (msg.id) {
            await db.query('DELETE FROM messages WHERE id = $1', [msg.id]);
          }
        }
      }

      // Reset the message counter
      memoryService.resetMessageCount(roomId);

      logger.info(
        `Summarization complete: ${messagesToSummarize.length} messages summarized, ${messagesToKeep.length} kept`
      );
    } catch (error) {
      logger.error({ error }, 'Error during summarization:');
    }
  },

  examples: [],
};
