import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Media,
  type Memory,
  type State,
} from "@elizaos/core";
import { BLOOIO_SERVICE_NAME } from "../constants";
import type { BlooioService } from "../service";
import type { BlooioAttachment } from "../types";
import {
  extractAttachmentUrls,
  extractChatIdCandidates,
  stripChatIdsFromText,
  validateChatId,
} from "../utils";

const sendMessageAction: Action = {
  name: "SEND_MESSAGE",
  description: "Send a message via Blooio to a chat (phone, email, or group)",
  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    const blooioService = runtime.getService(BLOOIO_SERVICE_NAME);
    if (!blooioService) {
      logger.error("Blooio service not found");
      return false;
    }

    const text = typeof message.content?.text === "string" ? message.content.text : "";
    const candidates = extractChatIdCandidates(text);
    return candidates.some((candidate) => validateChatId(candidate));
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    try {
      const blooioService = runtime.getService(BLOOIO_SERVICE_NAME) as BlooioService | null;
      if (!blooioService) {
        throw new Error("Blooio service not available");
      }

      const text = typeof message.content?.text === "string" ? message.content.text : "";
      const candidates = extractChatIdCandidates(text);
      const validRecipients = candidates.filter((candidate) => validateChatId(candidate));

      if (validRecipients.length === 0) {
        throw new Error("No valid chat identifier found in message");
      }

      const chatId = validRecipients.map((recipient) => recipient.trim()).join(",");

      // Collect attachments from multiple sources
      const outboundAttachments: Array<string | BlooioAttachment> = [];

      // 1. Extract URLs mentioned in the text
      const urlsFromText = extractAttachmentUrls(text);
      for (const url of urlsFromText) {
        outboundAttachments.push(url);
      }

      // 2. Add attachments from message.content.attachments (Media[])
      const contentAttachments = message.content?.attachments;
      if (contentAttachments && Array.isArray(contentAttachments)) {
        for (const attachment of contentAttachments) {
          if (typeof attachment === "object" && attachment !== null) {
            const media = attachment as Media;
            if (media.url) {
              outboundAttachments.push({
                url: media.url,
                name: media.title ?? media.description ?? undefined,
              });
            }
          }
        }
      }

      // Clean up message text
      let messageContent = stripChatIdsFromText(text, validRecipients);
      for (const url of urlsFromText) {
        messageContent = messageContent.replace(url, "");
      }
      messageContent = messageContent
        // Remove command phrases like "send a message", "send to", "text", etc.
        .replace(/send\s+(a\s+)?(message|text|imessage|sms)?\s*(to)?\s*/gi, "")
        // Remove standalone "to" at the start
        .replace(/^\s*to\s+/i, "")
        // Remove "saying" or "with" followed by optional space
        .replace(/^\s*(saying|with)\s*/gi, "")
        // Remove quotes at start and end
        .replace(/^\s*["']|["']\s*$/g, "")
        // Normalize whitespace
        .replace(/\s+/g, " ")
        .trim();

      // Clear if only command keywords remain
      if (/^(send|message|text|imessage|sms|saying|with|to)?$/i.test(messageContent)) {
        messageContent = "";
      }

      if (!messageContent && outboundAttachments.length === 0) {
        messageContent = "Hello from your assistant.";
      }

      await blooioService.sendMessage(chatId, {
        text: messageContent || undefined,
        attachments: outboundAttachments.length > 0 ? outboundAttachments : undefined,
      });

      const successText = `Message sent successfully to ${chatId}`;
      if (callback) {
        await callback({
          text: successText,
          success: true,
        });
      }
      return { success: true, text: successText };
    } catch (error) {
      logger.error({ error: String(error) }, "Error sending message via Blooio");
      const errorText = `Failed to send message: ${error instanceof Error ? error.message : "Unknown error"}`;
      if (callback) {
        await callback({
          text: errorText,
          success: false,
        });
      }
      return { success: false, text: errorText };
    }
  },
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Send a message to +17147023671 saying 'Hello from Blooio!'",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll send that message.",
          action: "SEND_MESSAGE",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Message jane@example.com with 'Your iMessage is ready.'",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Sending that now.",
          action: "SEND_MESSAGE",
        },
      },
    ],
  ],
  similes: ["send message", "send imessage", "text", "message"],
};

export default sendMessageAction;
