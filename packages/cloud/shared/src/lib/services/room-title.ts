/**
 * Assigns deterministic conversation titles without a second model dispatch.
 * Title generation is best-effort metadata and must not create an unmetered
 * provider call after the user-visible response has already completed.
 */
import { memoriesRepository, roomsRepository } from "../../db/repositories";
import { logger } from "../utils/logger";

/**
 * Generate a deterministic title for a room based on the first user message.
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

  const title = generateFallbackTitle(text);

  await roomsRepository.update(roomId, { name: title });

  logger.info(`[RoomTitle] Set title for room ${roomId}: "${title}"`);

  return title;
}

/**
 * Intent prefixes must end on a boundary that respects Unicode letters, marks
 * and digits. An ASCII-only `\b` is not sufficient here: without it "Supérieur"
 * and "Hiện" are read as the greetings "sup"/"hi", "helpers" as "help" and
 * "fixes" as "fix". A negative lookahead keeps punctuation-terminated intents
 * ("hi!", "help?") classifying while rejecting a longer word that merely starts
 * with the same characters.
 */
const INTENT_BOUNDARY = "(?![\\p{L}\\p{M}\\p{N}_])";

function intentPattern(prefixes: string): RegExp {
  return new RegExp(`^(?:${prefixes})${INTENT_BOUNDARY}`, "iu");
}

const GREETING_INTENTS = "hi|hello|hey|howdy|greetings|yo|sup";
const QUESTION_INTENTS = "what|how|why|when|where|who|can|could|would|should|is|are|do|does";
const HELP_INTENTS = "help|assist|support|i need|please";
const CODE_INTENTS = "code|write|create|build|make|implement|debug|fix";
const EXPLAIN_INTENTS = "explain|tell me|describe|what is|define";

/**
 * Generate a descriptive title from the user message when AI fails.
 */
function generateFallbackTitle(message: string): string {
  const cleaned = message.trim().toLowerCase();

  // Common greeting patterns -> generic titles
  if (intentPattern(GREETING_INTENTS).test(cleaned)) {
    return "New Conversation";
  }

  // Question patterns
  if (intentPattern(QUESTION_INTENTS).test(cleaned)) {
    const words = message.trim().split(/\s+/).slice(0, 6);
    if (words.length >= 3) {
      return capitalizeFirst(words.slice(0, 5).join(" "));
    }
    return "Question & Answer";
  }

  // Help/assist patterns
  if (intentPattern(HELP_INTENTS).test(cleaned)) {
    return "Help Request";
  }

  // Code/technical patterns
  if (intentPattern(CODE_INTENTS).test(cleaned)) {
    return "Coding Assistance";
  }

  // Explain patterns
  if (intentPattern(EXPLAIN_INTENTS).test(cleaned)) {
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
