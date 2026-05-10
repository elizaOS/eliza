import {
  composePromptFromState,
  type Evaluator,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseKeyValueXml,
  type UUID,
} from "@elizaos/core";

/**
 * Room Title Generator Evaluator
 *
 * Automatically generates concise room titles from the first user message.
 * Runs in background to avoid blocking message processing.
 * Matches behavior of Claude and other AI chat apps.
 *
 * Pattern: Similar to reflection evaluator but focused on title generation
 */

export const roomTitleTemplate = `# Task: Generate Room Title

You are a title generator. Extract the CORE TOPIC from the conversation and create a 4-6 word Title Case summary.

# Instructions:
<instructions>
1. Read the conversation context
2. Identify the main topic or purpose
3. Create a concise, descriptive title (4-6 words)
4. Use Title Case (Capitalize Each Word)
5. DO NOT use words like "help", "need", "want", "how to"
6. Just state the topic directly
</instructions>

{{conversationLog}}

# Examples:
- "Can you help me write a Python script?" → Python Script Development
- "I need advice on dealing with coworkers" → Workplace Relationship Advice
- "i need help planning a trip to hawaii" → Planning Hawaii Vacation
- "What's the best way to learn ML?" → Machine Learning Introduction
- "help me debug my react app" → React App Debugging
- "I want to learn about investing" → Investment Basics Guide

# Output Format:
<response>
  <thought>What is the main topic of this conversation?</thought>
  <title>4-6 Word Title Case Summary</title>
</response>

IMPORTANT: Your response must ONLY contain the <response></response> XML block above. Start immediately with <response> and end with </response>.`;

/**
 * Handler - generates and saves room title
 * IMPORTANT: Runs as fire-and-forget to avoid blocking message response
 */
async function handler(runtime: IAgentRuntime, message: Memory): Promise<any> {
  const { roomId } = message;

  if (!roomId) {
    logger.debug("[RoomTitle] No roomId in message");
    return;
  }

  // Fire-and-forget: Don't block the message response
  // The title will be generated in the background
  generateTitleInBackground(runtime, message, roomId).catch((error) => {
    logger.error(
      "[RoomTitle] Background title generation failed:",
      error instanceof Error ? error.message : String(error),
    );
  });
}

/**
 * Background title generation - runs without blocking
 */
async function generateTitleInBackground(runtime: IAgentRuntime, message: Memory, roomId: string) {
  try {
    // Check if room already has a title
    const existingRoom = await runtime.getRoom(roomId as UUID);

    if (!existingRoom) {
      logger.debug(`[RoomTitle] Room not found: ${roomId}`);
      return;
    }

    // Skip if room already has a title (not "New Chat")
    if (existingRoom.name && existingRoom.name !== "New Chat") {
      logger.debug(`[RoomTitle] Room already has title: ${existingRoom.name}`);
      return;
    }

    // Get recent messages for context
    const recentMessages = await runtime.getMemories({
      tableName: "messages",
      roomId: roomId as UUID,
      count: 5, // Get first few messages for context
      unique: false,
    });

    if (recentMessages.length < 1) {
      logger.debug(`[RoomTitle] Not enough messages yet (${recentMessages.length}/1)`);
      return;
    }

    // Compose state with conversation context
    const state = await runtime.composeState(message, ["RECENT_MESSAGES"]);

    // Generate prompt
    const prompt = composePromptFromState({
      state,
      template: roomTitleTemplate,
    });

    // Use model to generate title
    const response = await runtime.useModel(ModelType.TEXT_SMALL, {
      prompt,
    });

    if (!response) {
      logger.warn("[RoomTitle] Empty response from model");
      return;
    }

    // Parse XML response
    const parsed = parseKeyValueXml(response) as {
      thought?: string;
      title?: string;
    } | null;

    if (!parsed?.title) {
      logger.warn("[RoomTitle] Failed to parse title from response");
      return;
    }

    // Clean up the title
    let title = parsed.title.trim().replace(/^["']|["']$/g, "");

    // Ensure Title Case
    title = title
      .split(" ")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(" ");

    // Limit length to avoid overly long titles
    if (title.length > 60) {
      title = title.substring(0, 57) + "...";
    }

    // Update room with the generated title using runtime
    await runtime.updateRoom({
      ...existingRoom,
      name: title,
    });

    logger.info(`[RoomTitle] ✓ Generated and saved room title: "${title}"`);

    // Cache that we've processed this room
    await runtime.setCache<boolean>(`room-title-generated-${roomId}`, true);
  } catch (error) {
    logger.error(
      "[RoomTitle] Error generating room title:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * Room Title Evaluator Export
 */
const legacyRoomTitleEvaluator = {
  name: "ROOM_TITLE",
  similes: ["GENERATE_ROOM_TITLE", "CONVERSATION_TITLE"],
  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    if (!message.roomId || !message.entityId) {
      return false;
    }

    // Check if we've already generated a title for this room
    const alreadyGenerated = await runtime.getCache<boolean>(
      `room-title-generated-${message.roomId}`,
    );

    if (alreadyGenerated) {
      return false;
    }

    // Get messages from this specific user (entityId) to cheeck if this is their first message
    // We only need to check the last 2 messages from this user
    const userMessages = await runtime.getMemories({
      tableName: "messages",
      roomId: message.roomId,
      entityId: message.entityId, // Filter by user who sent the message
      count: 3,
      unique: false,
    });

    // Filter messages by entityId since DB filter might not work properly
    const filteredUserMessages = userMessages.filter((msg) => msg.entityId === message.entityId);

    const result = filteredUserMessages.length === 1;
    return result;
  },
  description: "Generates a concise, descriptive room title from the first user message.",
  handler,
  examples: [],
};

export const roomTitleEvaluator = legacyRoomTitleEvaluator as unknown as Evaluator;
