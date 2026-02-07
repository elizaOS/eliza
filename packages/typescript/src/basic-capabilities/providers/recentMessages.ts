import { triggerAutoCompaction } from "../../bootstrap/services/autoCompaction.ts";
import { getEntityDetails } from "../../entities.ts";
import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import { logger } from "../../logger.ts";
import type {
  CustomMetadata,
  Entity,
  IAgentRuntime,
  Memory,
  Provider,
  State,
  UUID,
} from "../../types/index.ts";
import { ChannelType } from "../../types/index.ts";
import {
  addHeader,
  DEFAULT_MAX_CONVERSATION_TOKENS,
  estimateTokens,
  formatMessages,
  formatPosts,
} from "../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("RECENT_MESSAGES");

// Move getRecentInteractions outside the provider
/**
 * Retrieves the recent interactions between two entities in a specific context.
 *
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {UUID} sourceEntityId - The UUID of the source entity.
 * @param {UUID} targetEntityId - The UUID of the target entity.
 * @param {UUID} excludeRoomId - The UUID of the room to exclude from the search.
 * @returns {Promise<Memory[]>} A promise that resolves to an array of Memory objects representing recent interactions.
 */
/**
 * Retrieves the recent interactions between two entities in different rooms excluding a specific room.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {UUID} sourceEntityId - The UUID of the source entity.
 * @param {UUID} targetEntityId - The UUID of the target entity.
 * @param {UUID} excludeRoomId - The UUID of the room to exclude from the search.
 * @returns {Promise<Memory[]>} An array of Memory objects representing recent interactions between the two entities.
 */
const getRecentInteractions = async (
  runtime: IAgentRuntime,
  sourceEntityId: UUID,
  targetEntityId: UUID,
  excludeRoomId: UUID,
): Promise<Memory[]> => {
  // Find all rooms where sourceEntityId and targetEntityId are participants
  const rooms = await runtime.getRoomsForParticipants([
    sourceEntityId,
    targetEntityId,
  ]);

  // Check the existing memories in the database
  return runtime.getMemoriesByRoomIds({
    tableName: "messages",
    // filter out the current room id from rooms
    roomIds: rooms.filter((room) => room !== excludeRoomId),
    limit: 20,
  });
};

/**
 * A provider object that retrieves recent messages, interactions, and memories based on a given message.
 * @typedef {object} Provider
 * @property {string} name - The name of the provider ("RECENT_MESSAGES").
 * @property {string} description - A description of the provider's purpose ("Recent messages, interactions and other memories").
 * @property {number} position - The position of the provider (100).
 * @property {Function} get - Asynchronous function that retrieves recent messages, interactions, and memories.
 * @param {IAgentRuntime} runtime - The runtime context for the agent.
 * @param {Memory} message - The message to retrieve data from.
 * @returns {object} An object containing data, values, and text sections.
 */
export const recentMessagesProvider: Provider = {
  name: spec.name,
  description: spec.description,
  position: spec.position ?? 100,
  get: async (runtime: IAgentRuntime, message: Memory, _state: State) => {
    const { roomId } = message;
    const conversationLength = runtime.getConversationLength();

    // Autonomy messages don't need the full conversation history — cap at a
    // small window to avoid loading hundreds of accumulated thought entries.
    const AUTONOMY_CONVERSATION_CAP = 10;
    const isAutonomousMessage =
      message.content?.metadata &&
      typeof message.content.metadata === "object" &&
      !Array.isArray(message.content.metadata) &&
      (message.content.metadata as Record<string, unknown>).isAutonomous ===
        true;
    const effectiveConversationLength = isAutonomousMessage
      ? Math.min(conversationLength, AUTONOMY_CONVERSATION_CAP)
      : conversationLength;

    // First get room to check for compaction point
    const room = await runtime.getRoom(roomId);

    // Check for compaction point - only load messages after this timestamp
    const lastCompactionAt = room?.metadata?.lastCompactionAt as
      | number
      | undefined;

    // Token budget for conversation context (configurable via setting)
    const maxConversationTokens =
      Number(runtime.getSetting("MAX_CONVERSATION_TOKENS")) ||
      DEFAULT_MAX_CONVERSATION_TOKENS;

    // Parallelize initial data fetching operations including recentInteractions
    const [entitiesData, recentMessagesData, recentInteractionsData] =
      await Promise.all([
        getEntityDetails({ runtime, roomId }),
        runtime.getMemories({
          tableName: "messages",
          roomId,
          count: effectiveConversationLength,
          unique: false,
          // Use compaction point to filter history
          start: lastCompactionAt,
        }),
        message.entityId !== runtime.agentId
          ? getRecentInteractions(
              runtime,
              message.entityId,
              runtime.agentId,
              roomId,
            )
          : Promise.resolve([]),
      ]);

    // ── Per-message size cap ────────────────────────────────────────────
    // Prevent a single enormous message (e.g. pasted document, base64 data,
    // tool output dump) from consuming the entire token budget.  Messages
    // over the cap are truncated with a notice so the agent knows content
    // was cut.
    const MAX_SINGLE_MESSAGE_CHARS = 20_000; // ~5 000 tokens per message
    const cappedMessagesData = recentMessagesData.map((msg) => {
      const text = msg.content?.text || "";
      if (text.length > MAX_SINGLE_MESSAGE_CHARS) {
        return {
          ...msg,
          content: {
            ...msg.content,
            text:
              text.slice(0, MAX_SINGLE_MESSAGE_CHARS) +
              "\n\n[... message truncated — original was " +
              `${text.length.toLocaleString()} chars]`,
          },
        };
      }
      return msg;
    });

    // ── Token-based budgeting ─────────────────────────────────────────
    // Keep the most recent messages within the token limit.  Sort
    // newest-first so the budget preserves the most recent conversation.
    //
    // The budget estimates tokens from raw message text, but the formatted
    // output (with timestamps, usernames, headers) is ~30 % larger.  We
    // apply this overhead factor so the formatted prompt stays within budget.
    const FORMATTING_OVERHEAD = 1.3;
    const effectiveBudget = Math.floor(
      maxConversationTokens / FORMATTING_OVERHEAD,
    );

    const sortedByRecent = [...cappedMessagesData].sort(
      (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
    );
    let tokenCount = 0;
    const budgetedMessages: Memory[] = [];
    for (const msg of sortedByRecent) {
      const msgTokens = estimateTokens(msg.content?.text || "");
      if (
        tokenCount + msgTokens > effectiveBudget &&
        budgetedMessages.length > 0
      ) {
        break;
      }
      budgetedMessages.push(msg);
      tokenCount += msgTokens;
    }
    // Restore chronological order for formatting
    budgetedMessages.reverse();

    // Trigger auto-compaction if messages were dropped and auto-compact is enabled
    const messagesWereTrimmed =
      budgetedMessages.length < cappedMessagesData.length;
    const autoCompact = runtime.getSetting("AUTO_COMPACT") !== "false";
    if (messagesWereTrimmed && autoCompact) {
      logger.info(
        {
          src: "provider:recent-messages",
          roomId,
          totalMessages: recentMessagesData.length,
          keptMessages: budgetedMessages.length,
          estimatedTokens: tokenCount,
        },
        "Token budget exceeded, triggering auto-compaction",
      );
      triggerAutoCompaction(runtime, roomId).catch((err) => {
        const errMsg = err instanceof Error ? err.message : String(err);
        logger.warn(
          { src: "provider:recent-messages", roomId, error: errMsg },
          "Auto-compaction failed",
        );
      });
    }

    // Separate action results from regular messages
    const actionResultMessages = budgetedMessages.filter(
      (msg) => msg.content && msg.content.type === "action_result",
    );

    const dialogueMessages = budgetedMessages.filter(
      (msg) => !(msg.content && msg.content.type === "action_result"),
    );

    // Default to message format if room is not found or type is undefined
    const isPostFormat = room?.type
      ? room.type === ChannelType.FEED || room.type === ChannelType.THREAD
      : false;

    // Format recent messages and posts in parallel, using only dialogue messages
    const [formattedRecentMessages, formattedRecentPosts] = await Promise.all([
      formatMessages({
        messages: dialogueMessages,
        entities: entitiesData,
      }),
      formatPosts({
        messages: dialogueMessages,
        entities: entitiesData,
        conversationHeader: false,
      }),
    ]);

    // Format action results separately
    let actionResultsText = "";
    if (actionResultMessages.length > 0) {
      // Group by runId using Map
      const groupedByRun = new Map<string, Memory[]>();

      for (const mem of actionResultMessages) {
        const runId: string = String(mem.content?.runId || "unknown");
        if (!groupedByRun.has(runId)) {
          groupedByRun.set(runId, []);
        }
        const memories = groupedByRun.get(runId);
        if (memories) {
          memories.push(mem);
        }
      }

      const formattedActionResults = Array.from(groupedByRun.entries())
        .slice(-3) // Show last 3 runs
        .map(([runId, memories]) => {
          const sortedMemories = memories.sort(
            (a: Memory, b: Memory) => (a.createdAt || 0) - (b.createdAt || 0),
          );

          const firstMemory = sortedMemories[0];
          const thought = firstMemory?.content?.planThought || "";
          const runText = sortedMemories
            .map((mem: Memory) => {
              const memContent = mem.content;
              const actionName = memContent?.actionName || "Unknown";
              const status = memContent?.actionStatus || "unknown";
              const planStep = memContent?.planStep || "";
              const text = memContent?.text || "";
              const error = memContent?.error || "";

              let memText = `  - ${actionName} (${status})`;
              if (planStep) {
                memText += ` [${planStep}]`;
              }
              if (error) {
                memText += `: Error - ${error}`;
              } else if (text && text !== `Executed action: ${actionName}`) {
                memText += `: ${text}`;
              }

              return memText;
            })
            .join("\n");

          return `**Action Run ${runId.slice(0, 8)}**${thought ? ` - "${thought}"` : ""}\n${runText}`;
        })
        .join("\n\n");

      actionResultsText = formattedActionResults
        ? addHeader("# Recent Action Executions", formattedActionResults)
        : "";
    }

    // Create formatted text with headers
    const recentPosts =
      formattedRecentPosts && formattedRecentPosts.length > 0
        ? addHeader("# Posts in Thread", formattedRecentPosts)
        : "";

    const recentMessages =
      formattedRecentMessages && formattedRecentMessages.length > 0
        ? addHeader("# Conversation Messages", formattedRecentMessages)
        : "";

    // If there are no messages at all, and no current message to process, return a specific message.
    // The check for dialogueMessages.length === 0 ensures we only show this if there's truly nothing.
    if (
      !recentPosts &&
      !recentMessages &&
      dialogueMessages.length === 0 &&
      !message.content.text
    ) {
      return {
        data: {
          recentMessages: dialogueMessages,
          recentInteractions: [],
          actionResults: actionResultMessages,
        },
        values: {
          recentPosts: "",
          recentMessages: "",
          recentMessageInteractions: "",
          recentPostInteractions: "",
          recentInteractions: "",
          recentActionResults: actionResultsText,
        },
        text: "No recent messages available",
      };
    }

    let recentMessage = "No recent message available.";

    if (dialogueMessages.length > 0) {
      // Get the most recent dialogue message (create a copy to avoid mutating original array)
      const mostRecentMessage = [...dialogueMessages].sort(
        (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      )[0];

      // Format just this single message to get the internal thought
      const formattedSingleMessage = formatMessages({
        messages: [mostRecentMessage],
        entities: entitiesData,
      });

      if (formattedSingleMessage) {
        recentMessage = formattedSingleMessage;
      }
    }

    const metaData = message.metadata as CustomMetadata;
    const foundEntity = entitiesData.find(
      (entity: Entity) => entity.id === message.entityId,
    );
    const senderName =
      foundEntity?.names?.[0] || metaData?.entityName || "Unknown User";
    const receivedMessageContent = message.content.text;

    const hasReceivedMessage = !!receivedMessageContent?.trim();

    const receivedMessageHeader = hasReceivedMessage
      ? addHeader(
          "# Received Message",
          `${senderName}: ${receivedMessageContent}`,
        )
      : "";

    const focusHeader = hasReceivedMessage
      ? addHeader(
          "# Focus your response",
          `You are replying to the above message from **${senderName}**. Keep your answer relevant to that message. Do not repeat earlier replies unless the sender asks again.`,
        )
      : "";

    // Preload all necessary entities for both types of interactions
    const interactionEntityMap = new Map<UUID, Entity>();

    // Only proceed if there are interactions to process
    if (recentInteractionsData.length > 0) {
      // Get unique entity IDs that aren't the runtime agent
      const uniqueEntityIds = [
        ...new Set(
          recentInteractionsData
            .map((message) => message.entityId)
            .filter((id) => id !== runtime.agentId),
        ),
      ];

      // Create a Set for faster lookup
      const uniqueEntityIdSet = new Set(uniqueEntityIds);

      // Add entities already fetched in entitiesData to the map
      const entitiesDataIdSet = new Set<UUID>();
      entitiesData.forEach((entity) => {
        if (uniqueEntityIdSet.has(entity.id)) {
          interactionEntityMap.set(entity.id, entity);
          entitiesDataIdSet.add(entity.id);
        }
      });

      // Get the remaining entities that weren't already loaded
      // Use Set difference for efficient filtering
      const remainingEntityIds = uniqueEntityIds.filter(
        (id) => !entitiesDataIdSet.has(id),
      );

      // Only fetch the entities we don't already have
      if (remainingEntityIds.length > 0) {
        const entities = await Promise.all(
          remainingEntityIds.map((entityId) => runtime.getEntityById(entityId)),
        );

        entities.forEach((entity, index) => {
          if (entity) {
            interactionEntityMap.set(remainingEntityIds[index], entity);
          }
        });
      }
    }

    // Format recent message interactions
    const getRecentMessageInteractions = async (
      recentInteractionsData: Memory[],
    ): Promise<string> => {
      // Format messages using the pre-fetched entities
      const formattedInteractions = recentInteractionsData.map((message) => {
        const isSelf = message.entityId === runtime.agentId;
        let sender: string;

        if (isSelf) {
          sender = runtime.character.name ?? "Agent";
        } else {
          const interactionEntity = interactionEntityMap.get(message.entityId);
          const interactionMetadata = interactionEntity?.metadata;
          sender =
            (interactionMetadata && (interactionMetadata.userName as string)) ||
            "unknown";
        }

        return `${sender}: ${message.content.text}`;
      });

      return formattedInteractions.join("\n");
    };

    // Format recent post interactions
    const getRecentPostInteractions = async (
      recentInteractionsData: Memory[],
      entities: Entity[],
    ): Promise<string> => {
      // Combine pre-loaded entities with any other entities
      const combinedEntities = [...entities];

      // Add entities from interactionEntityMap that aren't already in entities
      const actorIds = new Set(entities.map((entity) => entity.id));
      for (const [id, entity] of interactionEntityMap.entries()) {
        if (!actorIds.has(id)) {
          combinedEntities.push(entity);
        }
      }

      const formattedInteractions = formatPosts({
        messages: recentInteractionsData,
        entities: combinedEntities,
        conversationHeader: true,
      });

      return formattedInteractions;
    };

    // Process both types of interactions in parallel
    const [recentMessageInteractions, recentPostInteractions] =
      await Promise.all([
        getRecentMessageInteractions(recentInteractionsData),
        getRecentPostInteractions(recentInteractionsData, entitiesData),
      ]);

    const data = {
      recentMessages: dialogueMessages,
      recentInteractions: recentInteractionsData,
      actionResults: actionResultMessages,
    };

    const values = {
      recentPosts,
      recentMessages,
      recentMessageInteractions,
      recentPostInteractions,
      recentInteractions: isPostFormat
        ? recentPostInteractions
        : recentMessageInteractions,
      recentActionResults: actionResultsText,
      recentMessage,
    };

    // Combine all text sections
    const text = [
      isPostFormat ? recentPosts : recentMessages,
      actionResultsText, // Include action results in the text output
      // Only add received message and focus headers if there are messages or a current message to process
      recentMessages || recentPosts || message.content.text
        ? receivedMessageHeader
        : "",
      recentMessages || recentPosts || message.content.text ? focusHeader : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    return {
      data: {
        recentMessages: data.recentMessages,
        recentInteractions: data.recentInteractions,
        actionResults: data.actionResults,
      },
      values,
      text,
    };
  },
};
