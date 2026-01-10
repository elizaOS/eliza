import {
  type IAgentRuntime,
  type Memory,
  type Evaluator,
  logger,
  ModelType,
  composePromptFromState,
  type UUID,
} from "@elizaos/core";
import { MemoryService } from "../services/memory-service";
import type { SummaryResult } from "../types/index";

/**
 * Helper function to get dialogue messages count (excluding action results)
 * This matches the filtering logic in short-term-memory provider
 */
async function getDialogueMessageCount(
  runtime: IAgentRuntime,
  roomId: UUID
): Promise<number> {
  // We need to fetch messages to filter them properly
  // Fetch a reasonable batch to check
  const messages = await runtime.getMemories({
    tableName: "messages",
    roomId,
    count: 100, // Check last 100 messages
    unique: false,
  });

  const dialogueMessages = messages.filter(
    (msg) =>
      !(
        msg.content?.type === "action_result" &&
        msg.metadata?.type === "action_result"
      ) &&
      (msg.metadata?.type === "agent_response_message" ||
        msg.metadata?.type === "user_message")
  );

  return dialogueMessages.length;
}

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

  const summary = summaryMatch
    ? summaryMatch[1].trim()
    : "Summary not available";
  const topics = topicsMatch
    ? topicsMatch[1]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];
  const keyPoints = Array.from(keyPointsMatches).map((match) =>
    match[1].trim()
  );

  return { summary, topics, keyPoints };
}

/**
 * Short-term Memory Summarization Evaluator
 *
 * Automatically generates and updates conversation summaries when conversations
 * exceed the configured threshold (default: 16 messages).
 *
 * BEHAVIOR:
 * - Monitors message count per room
 * - Creates initial summary when count >= threshold (e.g., 16 messages)
 * - Updates summary at regular intervals (e.g., every 10 new messages)
 * - Condenses existing summary with new messages to stay under token limit
 * - Tracks offset to avoid re-processing messages
 * - Caps new messages per update to prevent context bloat (default: 20)
 *
 * OPTIMIZATION:
 * - Only triggers LLM when crossing threshold or interval boundaries
 * - Processes only NEW messages since last update
 * - Maintains rolling summary (fixed size, not ever-growing)
 * - LLM is instructed to merge and condense, keeping under 2500 tokens
 *
 * INTEGRATION:
 * Works with shortTermMemoryProvider which:
 * - Shows full conversation when < threshold (no summarization needed)
 * - Shows summaries + recent messages when >= threshold (optimized context)
 *
 * This creates an adaptive system that starts with full context and seamlessly
 * transitions to efficient summarization as conversations grow.
 */
export const summarizationEvaluator: Evaluator = {
  name: "MEMORY_SUMMARIZATION",
  description:
    "Automatically summarizes conversations to optimize context usage",
  similes: [
    "CONVERSATION_SUMMARY",
    "CONTEXT_COMPRESSION",
    "MEMORY_OPTIMIZATION",
  ],
  alwaysRun: true,

  validate: async (
    runtime: IAgentRuntime,
    message: Memory
  ): Promise<boolean> => {
    // Only run after actual messages (not during generation or on empty messages)
    if (!message.content?.text) {
      return false;
    }

    const memoryService = runtime.getService("memory") as MemoryService | null;
    if (!memoryService) {
      return false;
    }

    const config = memoryService.getConfig();

    // Get dialogue message count (excluding action results)
    const currentDialogueCount = await getDialogueMessageCount(
      runtime,
      message.roomId
    );

    // Get existing summary to check if we need initial or update
    const existingSummary = await memoryService.getCurrentSessionSummary(
      message.roomId
    );

    if (!existingSummary) {
      // No summary yet - create initial summary when dialogue threshold is reached
      const shouldSummarize =
        currentDialogueCount >= config.shortTermSummarizationThreshold;
      return shouldSummarize;
    } else {
      // Summary exists - check if we have enough new dialogue messages since last update
      const newDialogueCount =
        currentDialogueCount - existingSummary.lastMessageOffset;
      const shouldUpdate =
        newDialogueCount >= config.shortTermSummarizationInterval;
      return shouldUpdate;
    }
  },

  handler: async (runtime: IAgentRuntime, message: Memory): Promise<void> => {
    const memoryService = runtime.getService("memory") as MemoryService;
    if (!memoryService) {
      logger.error("MemoryService not found");
      return;
    }

    const config = memoryService.getConfig();
    const { roomId } = message;

    try {
      logger.info(`Starting summarization for room ${roomId}`);

      // Get the current summary (if any)
      const existingSummary = await memoryService.getCurrentSessionSummary(
        roomId
      );
      const lastOffset = existingSummary?.lastMessageOffset || 0;

      // Get all messages and filter to dialogue only
      const allMessages = await runtime.getMemories({
        tableName: "messages",
        roomId,
        count: 1000, // Get a large batch to ensure we have all relevant messages
        unique: false,
      });

      // Filter to dialogue messages only (matching provider logic)
      const allDialogueMessages = allMessages.filter(
        (msg) =>
          !(
            msg.content?.type === "action_result" &&
            msg.metadata?.type === "action_result"
          ) &&
          (msg.metadata?.type === "agent_response_message" ||
            msg.metadata?.type === "user_message")
      );

      // Get total dialogue message count
      const totalDialogueCount = allDialogueMessages.length;

      // Calculate how many new dialogue messages we have since last summary
      const newDialogueCount = totalDialogueCount - lastOffset;

      if (newDialogueCount === 0) {
        logger.debug("No new dialogue messages to summarize");
        return;
      }

      // Cap the number of new messages to prevent context bloat
      const maxNewMessages = config.summaryMaxNewMessages || 50;
      const messagesToProcess = Math.min(newDialogueCount, maxNewMessages);

      // Log if we're hitting the cap
      if (newDialogueCount > maxNewMessages) {
        logger.warn(
          `Capping new dialogue messages at ${maxNewMessages} (${newDialogueCount} available). Oldest messages will be skipped.`
        );
      }

      // Sort all dialogue messages by timestamp
      const sortedDialogueMessages = allDialogueMessages.sort(
        (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
      );

      // Get new dialogue messages since last offset
      const newDialogueMessages = sortedDialogueMessages.slice(
        lastOffset,
        lastOffset + messagesToProcess
      );

      if (newDialogueMessages.length === 0) {
        logger.debug("No new dialogue messages retrieved after filtering");
        return;
      }

      // Format messages for summarization
      const formattedMessages = newDialogueMessages
        .map((msg) => {
          const sender =
            msg.entityId === runtime.agentId ? runtime.character.name : "User";
          return `${sender}: ${msg.content.text || "[non-text message]"}`;
        })
        .join("\n");

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
            existingTopics: existingSummary.topics?.join(", ") || "None",
            newMessages: formattedMessages,
          },
          template,
        });
      } else {
        // Create initial summary - use ALL dialogue messages for comprehensive initial summary
        const initialMessages = sortedDialogueMessages
          .map((msg) => {
            const sender =
              msg.entityId === runtime.agentId
                ? runtime.character.name
                : "User";
            return `${sender}: ${msg.content.text || "[non-text message]"}`;
          })
          .join("\n");

        template = initialSummarizationTemplate;
        prompt = composePromptFromState({
          state: {
            ...state,
            recentMessages: initialMessages,
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
        `${
          existingSummary ? "Updated" : "Generated"
        } summary: ${summaryResult.summary.substring(0, 100)}...`
      );

      // Calculate new offset based on dialogue messages processed
      const newOffset = lastOffset + newDialogueMessages.length;

      // Get timing info
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
        // Update existing summary
        await memoryService.updateSessionSummary(existingSummary.id, roomId, {
          summary: summaryResult.summary,
          messageCount:
            existingSummary.messageCount + newDialogueMessages.length,
          lastMessageOffset: newOffset,
          endTime,
          topics: summaryResult.topics,
          metadata: {
            keyPoints: summaryResult.keyPoints,
          },
        });

        logger.info(
          `Updated summary for room ${roomId}: ${newDialogueMessages.length} new dialogue messages processed (offset: ${lastOffset} → ${newOffset})`
        );
      } else {
        // Create new summary - offset is total dialogue count
        await memoryService.storeSessionSummary({
          agentId: runtime.agentId,
          roomId,
          entityId:
            message.entityId !== runtime.agentId ? message.entityId : undefined,
          summary: summaryResult.summary,
          messageCount: totalDialogueCount,
          lastMessageOffset: totalDialogueCount,
          startTime,
          endTime,
          topics: summaryResult.topics,
          metadata: {
            keyPoints: summaryResult.keyPoints,
          },
        });

        logger.info(
          `Created new summary for room ${roomId}: ${totalDialogueCount} dialogue messages summarized (offset: 0 → ${totalDialogueCount})`
        );
      }

      // Note: We do NOT delete messages - they stay in the database
      // The offset tracks what dialogue messages have been summarized
    } catch (error) {
      logger.error({ error }, "Error during summarization:");
    }
  },

  examples: [],
};
