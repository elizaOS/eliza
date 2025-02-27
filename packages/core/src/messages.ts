import { v4 } from "uuid";
import { composeContext } from "./context.ts";
import { generateMessageResponse, generateShouldRespond } from "./generation.ts";
import { logger } from "./logger.ts";
import { messageCompletionFooter, shouldRespondFooter } from "./parsing.ts";
import { ModelClass, type Actor, type Content, type HandlerCallback, type IAgentRuntime, type Memory, type State, type UUID } from "./types.ts";
import { stringToUuid } from "./uuid.ts";
export * as actions from "./actions";
export * as evaluators from "./evaluators";
export * as providers from "./providers";

/**
 * Get details for a list of actors.
 */
export async function getActorDetails({
  runtime,
  roomId,
}: {
  runtime: IAgentRuntime;
  roomId: UUID;
}) {
  const participantIds = await runtime.databaseAdapter.getParticipantsForRoom(
    roomId,
    runtime.agentId
  );
  
  // Fetch all actor details
  const actors = await Promise.all(
    participantIds.map(async (userId) => {
      const account = await runtime.databaseAdapter.getEntityById(userId, runtime.agentId);
      if (account) {
        return {
          id: account.id,
          name: account.metadata.name,
          username: account.metadata.username,
        };
      }
      return null;
    })
  );

  // Filter out nulls and ensure uniqueness by ID
  const uniqueActors = new Map();
  actors
    .filter((actor): actor is Actor => actor !== null)
    .forEach(actor => {
      if (!uniqueActors.has(actor.id)) {
        uniqueActors.set(actor.id, actor);
      }
    });

  return Array.from(uniqueActors.values());
}

/**
 * Format actors into a string
 * @param actors - list of actors
 * @returns string
 */
export function formatActors({ actors }: { actors: Actor[] }) {
  const actorStrings = actors.map((actor: Actor) => {
    const header = `${actor.name}`;
    return header;
  });
  const finalActorStrings = actorStrings.join("\n");
  return finalActorStrings;
}

/**
 * Format messages into a string
 * @param {Object} params - The formatting parameters
 * @param {Memory[]} params.messages - List of messages to format
 * @param {Actor[]} params.actors - List of actors for name resolution
 * @returns {string} Formatted message string with timestamps and user information
 */
export const formatMessages = ({
  messages,
  actors,
}: {
  messages: Memory[];
  actors: Actor[];
}) => {
  const messageStrings = messages
    .reverse()
    .filter((message: Memory) => message.userId)
    .map((message: Memory) => {
      const messageContent = (message.content as Content).text;
      const messageAction = (message.content as Content).action;
      const formattedName =
        actors.find((actor: Actor) => actor.id === message.userId)?.name ||
        "Unknown User";

      const attachments = (message.content as Content).attachments;

      const attachmentString =
        attachments && attachments.length > 0
          ? ` (Attachments: ${attachments
              .map((media) => `[${media.id} - ${media.title} (${media.url})]`)
              .join(", ")})`
          : "";

      const timestamp = formatTimestamp(message.createdAt);

      const shortId = message.userId.slice(-5);

      return `(${timestamp}) [${shortId}] ${formattedName}: ${messageContent}${attachmentString}${
        messageAction && messageAction !== "null" ? ` (${messageAction})` : ""
      }`;
    })
    .join("\n");
  return messageStrings;
};

export const formatTimestamp = (messageDate: number) => {
  const now = new Date();
  const diff = now.getTime() - messageDate;

  const absDiff = Math.abs(diff);
  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (absDiff < 60000) {
    return "just now";
  }if (minutes < 60) {
    return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
  }if (hours < 24) {
    return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
  }
    return `${days} day${days !== 1 ? "s" : ""} ago`;
};