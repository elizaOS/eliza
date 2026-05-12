import { generateText } from "ai";
import { memoriesRepository, roomsRepository } from "@/db/repositories";
import { getLanguageModel } from "@/lib/providers/language-model";
import { logger } from "@/lib/utils/logger";

/**
 * Generate an AI-powered title for a room based on the first user message.
 * Only generates if room currently has default title ("New Chat").
 *
 * @param roomId - The room ID to generate title for
 * @returns The generated title, or null if title generation was skipped
 */
export async function generateRoomTitle(roomId: string): Promise<string | null> {
  const room = await roomsRepository.findById(roomId);

  if (!room) {
    logger.warn(`[RoomTitle] Room not found: ${roomId}`);
    return null;
  }

  if (room.name && room.name !== "New Chat") {
    logger.info(`[RoomTitle] Room already has title: ${room.name}`);
    return null;
  }

  const messages = await memoriesRepository.findMessages(roomId, { limit: 6 });

  if (messages.length < 1) {
    return null;
  }

  const userMessage = messages.reverse().find((msg) => {
    const content = msg.content;
    const source = typeof content === "object" ? content?.source : undefined;
    return source === "user";
  });

  if (!userMessage) {
    return null;
  }

  const content = userMessage.content;
  const text = typeof content === "string" ? content : content?.text || "";

  if (!text || text.length < 3) {
    return null;
  }

  // Generate AI title
  let title: string;

  try {
    const prompt = `Create a brief 3-5 word title summarizing this message topic. Output ONLY the title, no quotes or explanation.

Message: ${text.slice(0, 300)}

Title:`;

    logger.info(`[RoomTitle] Generating AI title for room ${roomId}`);

    const result = await generateText({
      model: getLanguageModel("openai/gpt-5-mini"),
      prompt,
    });

    // Clean up the generated title
    title = result.text
      .trim()
      .replace(/^["']|["']$/g, "") // Remove quotes
      .replace(/^Title:\s*/i, "") // Remove "Title:" prefix if present
      .replace(/[.!?]$/, "") // Remove trailing punctuation
      .split("\n")[0] // Take only first line
      .slice(0, 50); // Limit length

    logger.info(`[RoomTitle] AI generated: "${title}"`);

    // Validate title is reasonable
    if (!title || title.length < 3 || title.length > 50) {
      logger.warn(`[RoomTitle] Invalid AI title, using fallback`);
      title = generateFallbackTitle(text);
    }
  } catch (error) {
    logger.error(`[RoomTitle] AI generation failed:`, error);
    title = generateFallbackTitle(text);
  }

  await roomsRepository.update(roomId, { name: title });

  logger.info(`[RoomTitle] Set title for room ${roomId}: "${title}"`);

  return title;
}

/**
 * Generate a descriptive title from the user message when AI fails.
 */
function generateFallbackTitle(message: string): string {
  const cleaned = message.trim().toLowerCase();

  // Common greeting patterns -> generic titles
  if (/^(hi|hello|hey|howdy|greetings|yo|sup)/i.test(cleaned)) {
    return "New Conversation";
  }

  // Question patterns
  if (/^(what|how|why|when|where|who|can|could|would|should|is|are|do|does)/i.test(cleaned)) {
    const words = message.trim().split(/\s+/).slice(0, 6);
    if (words.length >= 3) {
      return capitalizeFirst(words.slice(0, 5).join(" "));
    }
    return "Question & Answer";
  }

  // Help/assist patterns
  if (/^(help|assist|support|i need|please)/i.test(cleaned)) {
    return "Help Request";
  }

  // Code/technical patterns
  if (/^(code|write|create|build|make|implement|debug|fix)/i.test(cleaned)) {
    return "Coding Assistance";
  }

  // Explain patterns
  if (/^(explain|tell me|describe|what is|define)/i.test(cleaned)) {
    return "Explanation Request";
  }

  // For other messages, extract first few meaningful words
  const words = message.trim().split(/\s+/);
  if (words.length <= 5) {
    return capitalizeFirst(words.join(" ").replace(/[.!?]+$/, ""));
  }

  // Take first 5 words and capitalize
  const title = words.slice(0, 5).join(" ");
  return capitalizeFirst(title) + "...";
}

function capitalizeFirst(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
