import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { TWILIO_SERVICE_NAME } from "../constants";
import type { TwilioService } from "../service";
import { SendSmsSchema } from "../types";
import { chunkTextForSms, extractPhoneNumber, validateMessagingAddress } from "../utils";

const sendSmsAction: Action = {
  name: "SEND_SMS",
  description: "Send an SMS message to a phone number via Twilio",
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Check if Twilio service is available
    const twilioService = runtime.getService(TWILIO_SERVICE_NAME);
    if (!twilioService) {
      logger.error("Twilio service not found");
      return false;
    }

    // Check if message contains phone number and SMS intent
    const text = message.content.text || "";
    const phoneNumber = extractPhoneNumber(text);
    const hasSmsIntent =
      text.toLowerCase().includes("sms") ||
      text.toLowerCase().includes("text") ||
      text.toLowerCase().includes("message");

    return !!phoneNumber && hasSmsIntent;
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: any,
    callback?: HandlerCallback
  ) => {
    try {
      const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
      if (!twilioService) {
        throw new Error("Twilio service not available");
      }

      const text = message.content.text || "";

      // Extract phone number from the message
      const phoneNumber = extractPhoneNumber(text);
      if (!phoneNumber) {
        throw new Error("No phone number found in message");
      }

      // Extract the message content
      // Remove the phone number and command keywords from the text
      let messageContent = text
        .replace(phoneNumber, "")
        .replace(/^(send\s*(an?\s*)?(sms|text|message)\s*(to\s*)?|text\s+)/gi, "")
        .replace(/\b(saying|with\s*(the\s*)?(message|text))\b/gi, "")
        .trim();

      // Remove quotes if present
      messageContent = messageContent.replace(/^["']|["']$/g, "").trim();

      // If no message content extracted, use a default
      if (!messageContent) {
        messageContent = "Hello from your AI assistant!";
      }

      // Validate phone number
      if (!validateMessagingAddress(phoneNumber)) {
        throw new Error("Invalid phone number format");
      }

      // Handle long messages by chunking
      const messageChunks = chunkTextForSms(messageContent);

      // Send each chunk
      for (const chunk of messageChunks) {
        await twilioService.sendSms(phoneNumber, chunk);
        logger.info(`SMS sent to ${phoneNumber}: ${chunk.substring(0, 50)}...`);
      }

      if (callback) {
        callback({
          text: `SMS message sent successfully to ${phoneNumber}`,
          success: true,
        });
      }
    } catch (error) {
      logger.error({ error: String(error) }, "Error sending SMS");
      if (callback) {
        callback({
          text: `Failed to send SMS: ${error instanceof Error ? error.message : "Unknown error"}`,
          success: false,
        });
      }
    }
  },
  examples: [
    [
      {
        name: "user",
        content: {
          text: "Send an SMS to +18885551234 saying 'Hello from AI assistant!'",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll send that SMS message for you.",
          action: "SEND_SMS",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Text +15555551234 with the message 'Meeting confirmed for 3pm tomorrow'",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Sending the meeting confirmation SMS now.",
          action: "SEND_SMS",
        },
      },
    ],
  ],
  similes: ["send sms", "send text", "text message", "sms to", "text to", "message phone"],
};

export default sendSmsAction;
