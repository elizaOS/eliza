import {
  type IAgentRuntime,
  type Memory,
  type Evaluator,
  logger,
  ModelType,
  composePromptFromState,
  type UUID,
} from '@elizaos/core';
import { MemoryService } from '../services/memory-service';
import type { SummaryResult } from '../types';

/**
 * Helper function to get dialogue messages count (excluding action results)
 */
async function getDialogueMessageCount(runtime: IAgentRuntime, roomId: UUID): Promise<number> {
  const messages = await runtime.getMemories({
    tableName: 'messages',
    roomId,
    count: 100,
    unique: false,
  });

  const dialogueMessages = messages.filter(
    (msg) =>
      !((msg.content?.type as string) === 'action_result' && (msg.metadata?.type as string) === 'action_result') &&
      ((msg.metadata?.type as string) === 'agent_response_message' || (msg.metadata?.type as string) === 'user_message')
  );

  return dialogueMessages.length;
}

/**
 * Templates for memory summarization.
 * Auto-generated from prompts/*.txt
 * DO NOT EDIT - Generated from ../generated/prompts/typescript/prompts.ts
 */
import {
  initialSummarizationTemplate,
  updateSummarizationTemplate,
} from "../generated/prompts/typescript/prompts.js";

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
 */
export const summarizationEvaluator: Evaluator = {
  name: 'MEMORY_SUMMARIZATION',
  description: 'Automatically summarizes conversations to optimize context usage',
  similes: ['CONVERSATION_SUMMARY', 'CONTEXT_COMPRESSION', 'MEMORY_OPTIMIZATION'],
  alwaysRun: true,

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!message.content?.text) {
      return false;
    }

    const memoryService = runtime.getService('memory') as MemoryService | null;
    if (!memoryService) {
      return false;
    }

    const config = memoryService.getConfig();
    const currentDialogueCount = await getDialogueMessageCount(runtime, message.roomId);
    const existingSummary = await memoryService.getCurrentSessionSummary(message.roomId);

    if (!existingSummary) {
      return currentDialogueCount >= config.shortTermSummarizationThreshold;
    } else {
      const newDialogueCount = currentDialogueCount - existingSummary.lastMessageOffset;
      return newDialogueCount >= config.shortTermSummarizationInterval;
    }
  },

  handler: async (runtime: IAgentRuntime, message: Memory) => {
    const memoryService = runtime.getService('memory') as MemoryService;
    if (!memoryService) {
      logger.error('MemoryService not found');
      return undefined;
    }

    const config = memoryService.getConfig();
    const { roomId } = message;

    try {
      logger.info(`Starting summarization for room ${roomId}`);

      const existingSummary = await memoryService.getCurrentSessionSummary(roomId);
      const lastOffset = existingSummary?.lastMessageOffset || 0;

      const allMessages = await runtime.getMemories({
        tableName: 'messages',
        roomId,
        count: 1000,
        unique: false,
      });

      const allDialogueMessages = allMessages.filter(
        (msg) =>
          !((msg.content?.type as string) === 'action_result' && (msg.metadata?.type as string) === 'action_result') &&
          ((msg.metadata?.type as string) === 'agent_response_message' || (msg.metadata?.type as string) === 'user_message')
      );

      const totalDialogueCount = allDialogueMessages.length;
      const newDialogueCount = totalDialogueCount - lastOffset;

      if (newDialogueCount === 0) {
        logger.debug('No new dialogue messages to summarize');
        return undefined;
      }

      const maxNewMessages = config.summaryMaxNewMessages || 50;
      const messagesToProcess = Math.min(newDialogueCount, maxNewMessages);

      if (newDialogueCount > maxNewMessages) {
        logger.warn(
          `Capping new dialogue messages at ${maxNewMessages} (${newDialogueCount} available)`
        );
      }

      const sortedDialogueMessages = allDialogueMessages.sort(
        (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
      );

      const newDialogueMessages = sortedDialogueMessages.slice(
        lastOffset,
        lastOffset + messagesToProcess
      );

      if (newDialogueMessages.length === 0) {
        logger.debug('No new dialogue messages retrieved after filtering');
        return undefined;
      }

      const formattedMessages = newDialogueMessages
        .map((msg) => {
          const sender =
            msg.entityId === runtime.agentId ? runtime.character.name : 'User';
          return `${sender}: ${msg.content.text || '[non-text message]'}`;
        })
        .join('\n');

      const state = await runtime.composeState(message);
      let prompt: string;
      let template: string;

      if (existingSummary) {
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
        const initialMessages = sortedDialogueMessages
          .map((msg) => {
            const sender =
              msg.entityId === runtime.agentId ? runtime.character.name : 'User';
            return `${sender}: ${msg.content.text || '[non-text message]'}`;
          })
          .join('\n');

        template = initialSummarizationTemplate;
        prompt = composePromptFromState({
          state: { ...state, recentMessages: initialMessages },
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

      const newOffset = lastOffset + newDialogueMessages.length;
      const firstMessage = newDialogueMessages[0];
      const lastMessage = newDialogueMessages[newDialogueMessages.length - 1];

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
        await memoryService.updateSessionSummary(existingSummary.id, roomId, {
          summary: summaryResult.summary,
          messageCount: existingSummary.messageCount + newDialogueMessages.length,
          lastMessageOffset: newOffset,
          endTime,
          topics: summaryResult.topics,
          metadata: { keyPoints: summaryResult.keyPoints },
        });

        logger.info(
          `Updated summary for room ${roomId}: ${newDialogueMessages.length} new dialogue messages processed`
        );
      } else {
        await memoryService.storeSessionSummary({
          agentId: runtime.agentId,
          roomId,
          entityId: message.entityId !== runtime.agentId ? message.entityId : undefined,
          summary: summaryResult.summary,
          messageCount: totalDialogueCount,
          lastMessageOffset: totalDialogueCount,
          startTime,
          endTime,
          topics: summaryResult.topics,
          metadata: { keyPoints: summaryResult.keyPoints },
        });

        logger.info(
          `Created new summary for room ${roomId}: ${totalDialogueCount} dialogue messages summarized`
        );
      }
    } catch (error) {
      logger.error({ error }, 'Error during summarization:');
    }
    return undefined;
  },

  examples: [],
};

