import { requireProviderSpec } from "../../generated/spec-helpers.ts";
import type {
  IAgentRuntime,
  Media,
  Memory,
  Provider,
} from "../../types/index.ts";
import { addHeader } from "../../utils.ts";

// Get text content from centralized specs
const spec = requireProviderSpec("ATTACHMENTS");

/**
 * Provides a list of attachments in the current conversation.
 * @param {IAgentRuntime} runtime - The agent runtime object.
 * @param {Memory} message - The message memory object.
 * @returns {Object} The attachments values, data, and text.
 */
/**
 * Provides a list of attachments sent during the current conversation, including names, descriptions, and summaries.
 * @type {Provider}
 * @property {string} name - The name of the provider (ATTACHMENTS).
 * @property {string} description - Description of the provider.
 * @property {boolean} dynamic - Indicates if the provider is dynamic.
 * @property {function} get - Asynchronous function that retrieves attachments based on the runtime and message provided.
 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
 * @param {Memory} message - The message object containing content and attachments.
 * @returns {Object} An object containing values, data, and text about the attachments retrieved.
 */
export const attachmentsProvider: Provider = {
  name: spec.name,
  description: spec.description,
  dynamic: spec.dynamic ?? true,
  get: async (runtime: IAgentRuntime, message: Memory) => {
    // Start with any attachments in the current message
    const currentMessageAttachments = message.content.attachments || [];
    let allAttachments = [...currentMessageAttachments];

    const { roomId } = message;
    const conversationLength = runtime.getConversationLength();

    const recentMessagesData = await runtime.getMemories({
      roomId,
      count: conversationLength,
      unique: false,
      tableName: "messages",
    });

    // Process attachments from recent messages
    if (recentMessagesData && Array.isArray(recentMessagesData)) {
      const lastMessageWithAttachment = recentMessagesData.find(
        (msg) => msg.content.attachments && msg.content.attachments.length > 0,
      );

      if (lastMessageWithAttachment) {
        const lastMessageTime =
          lastMessageWithAttachment?.createdAt ?? Date.now();
        const oneHourBeforeLastMessage = lastMessageTime - 60 * 60 * 1000; // 1 hour before last message

        // Create a map of current message attachments by ID for quick lookup
        const currentAttachmentsMap = new Map(
          currentMessageAttachments.map((att) => [att.id, att]),
        );

        // Process recent messages and merge attachments
        const recentAttachments: Media[] = [];
        for (let i = recentMessagesData.length - 1; i >= 0; i -= 1) {
          const msg = recentMessagesData[i];
          const msgTime = msg.createdAt ?? Date.now();
          const isWithinTime = msgTime >= oneHourBeforeLastMessage;
          const attachments = msg.content.attachments ?? [];

          for (const attachment of attachments) {
            if (currentAttachmentsMap.has(attachment.id)) {
              continue;
            }
            if (!isWithinTime) {
              recentAttachments.push({ ...attachment, text: "[Hidden]" });
              continue;
            }
            recentAttachments.push(attachment);
          }
        }

        // Combine current message attachments (with rich data) and recent attachments
        allAttachments = [...currentMessageAttachments, ...recentAttachments];
      }
    }

    // Format attachments for display
    const formattedAttachments = allAttachments
      .map(
        (attachment) =>
          `ID: ${attachment.id}
    Name: ${attachment.title}
    URL: ${attachment.url}
    Type: ${attachment.source}
    Description: ${attachment.description}
    Text: ${attachment.text}
    `,
      )
      .join("\n");

    // Create formatted text with header
    const text =
      formattedAttachments && formattedAttachments.length > 0
        ? addHeader("# Attachments", formattedAttachments)
        : "";

    const values = {
      attachments: text,
    };
    const data = {
      attachments: allAttachments,
    };

    return {
      values,
      data,
      text,
    };
  },
};
