import {
  type IAgentRuntime,
  type Memory,
  type Evaluator,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { MemoryService } from '../services/memory-service';
import type { SummaryResult } from '../types/index';

/**
 * Template for generating initial conversation summary
 */
const initialSummarizationTemplate = `# Task: Summarize Conversation

You are analyzing a conversation to create a concise summary that captures the key points, topics, and important details.

# Recent Messages
{{recentMessages}}

# Instructions
Generate a summary that:
1. Captures the main topics discussed
2. Highlights key information shared
3. Notes any decisions made or questions asked
4. Maintains context for future reference
5. Is concise but comprehensive

**IMPORTANT**: Keep the summary under 2500 tokens. Be comprehensive but concise.

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
 * Template for updating/condensing an existing summary
 */
const updateSummarizationTemplate = `# Task: Update and Condense Conversation Summary

You are updating an existing conversation summary with new messages, while keeping the total summary concise.

# Existing Summary
{{existingSummary}}

# Existing Topics
{{existingTopics}}

# New Messages Since Last Summary
{{newMessages}}

# Instructions
Update the summary by:
1. Merging the existing summary with insights from the new messages
2. Removing redundant or less important details to stay under the token limit
3. Keeping the most important context and decisions
4. Adding new topics if they emerge
5. **CRITICAL**: Keep the ENTIRE updated summary under 2500 tokens

The goal is a rolling summary that captures the essence of the conversation without growing indefinitely.

Respond in this XML format:
<summary>
  <text>Your updated and condensed summary here</text>
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
  alwaysRun: true,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    logger.debug(`Validating summarization for message: ${message.content?.text}`);
    // Only run after messages (not on agent's own messages during generation)
    if (!message.content?.text) {
      return false;
    }

    const memoryService = runtime.getService('memory') as MemoryService | null;
    if (!memoryService) {
      return false;
    }

    const config = memoryService.getConfig();
    const currentMessageCount = await runtime.countMemories(message.roomId, false, 'messages');
    const shouldSummarize = currentMessageCount >= config.shortTermSummarizationThreshold;

    logger.debug(
      {
        roomId: message.roomId,
        currentMessageCount,
        threshold: config.shortTermSummarizationThreshold,
        shouldSummarize,
      },
      'Summarization check'
    );

    return shouldSummarize;
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

      // Get the current summary (if any)
      const existingSummary = await memoryService.getCurrentSessionSummary(roomId);
      const lastOffset = existingSummary?.lastMessageOffset || 0;

      // Get total message count
      const totalMessageCount = await runtime.countMemories(roomId, false, 'messages');

      // Get new messages since last offset
      const newMessages = await runtime.getMemories({
        tableName: 'messages',
        roomId,
        count: config.shortTermSummarizationThreshold,
        unique: false,
        start: lastOffset,
      });

      if (newMessages.length === 0) {
        logger.debug('No new messages to summarize');
        return;
      }

      // Sort by timestamp
      const sortedMessages = newMessages.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

      // Format messages for summarization
      const formattedMessages = sortedMessages
        .map((msg) => {
          const sender = msg.entityId === runtime.agentId ? runtime.character.name : 'User';
          return `${sender}: ${msg.content.text || '[non-text message]'}`;
        })
        .join('\n');

      // Generate or update summary using LLM
      const state = await runtime.composeState(message);
      let prompt: string;
      let template: string;

      if (existingSummary) {
        // Update existing summary
        template = updateSummarizationTemplate;
        prompt = composePromptFromState({
          state: {
            ...state,
            existingSummary: existingSummary.summary,
            existingTopics: existingSummary.topics?.join(', ') || 'None',
            newMessages: formattedMessages,
          },
          template,
        });
      } else {
        // Create initial summary
        template = initialSummarizationTemplate;
        prompt = composePromptFromState({
          state: {
            ...state,
            recentMessages: formattedMessages,
          },
          template,
        });
      }

      const response = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
        maxTokens: config.summaryMaxTokens || 2500,
      });

      const summaryResult = parseSummaryXML(response);

      logger.info(
        `${existingSummary ? 'Updated' : 'Generated'} summary: ${summaryResult.summary.substring(0, 100)}...`
      );

      // Calculate new offset (current total)
      const newOffset = totalMessageCount;

      // Get timing info
      const firstMessage = sortedMessages[0];
      const lastMessage = sortedMessages[sortedMessages.length - 1];

      const startTime = existingSummary
        ? existingSummary.startTime
        : firstMessage?.createdAt && firstMessage.createdAt > 0
          ? new Date(firstMessage.createdAt)
          : new Date();
      const endTime =
        lastMessage?.createdAt && lastMessage.createdAt > 0
          ? new Date(lastMessage.createdAt)
          : new Date();

      if (existingSummary) {
        // Update existing summary
        await memoryService.updateSessionSummary(existingSummary.id, {
          summary: summaryResult.summary,
          messageCount: existingSummary.messageCount + sortedMessages.length,
          lastMessageOffset: newOffset,
          endTime,
          topics: summaryResult.topics,
          metadata: {
            keyPoints: summaryResult.keyPoints,
          },
        });

        logger.info(
          `Updated summary for room ${roomId}: ${sortedMessages.length} new messages processed (offset: ${lastOffset} → ${newOffset})`
        );
      } else {
        // Create new summary
        await memoryService.storeSessionSummary({
          agentId: runtime.agentId,
          roomId,
          entityId: message.entityId !== runtime.agentId ? message.entityId : undefined,
          summary: summaryResult.summary,
          messageCount: sortedMessages.length,
          lastMessageOffset: newOffset,
          startTime,
          endTime,
          topics: summaryResult.topics,
          metadata: {
            keyPoints: summaryResult.keyPoints,
          },
        });

        logger.info(
          `Created new summary for room ${roomId}: ${sortedMessages.length} messages summarized (offset: 0 → ${newOffset})`
        );
      }

      // Note: We do NOT delete messages - they stay in the database
      // The offset tracks what's been summarized
    } catch (error) {
      logger.error({ error }, 'Error during summarization:');
    }
  },

  examples: [],
};
