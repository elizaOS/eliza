import {
  type Action,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { SUPPORTED_MEDIA_TYPES, TWILIO_SERVICE_NAME } from "../constants";
import type { TwilioService } from "../service";
import { SendMmsSchema } from "../types";
import { extractPhoneNumber, validateMessagingAddress } from "../utils";

const sendMmsAction: Action = {
  name: "SEND_MMS",
  description: "Send an MMS (multimedia message) with images, audio, or video via Twilio",
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Check if Twilio service is available
    const twilioService = runtime.getService(TWILIO_SERVICE_NAME);
    if (!twilioService) {
      logger.error("Twilio service not found");
      return false;
    }

    // Check if message contains phone number and media intent
    const text = message.content.text || "";
    const phoneNumber = extractPhoneNumber(text);
    const mediaIntent =
      text.toLowerCase().includes("image") ||
      text.toLowerCase().includes("photo") ||
      text.toLowerCase().includes("picture") ||
      text.toLowerCase().includes("video") ||
      text.toLowerCase().includes("media") ||
      text.toLowerCase().includes("mms");

    // Also check for URLs that might be media
    const urlPattern = /https?:\/\/[^\s]+/g;
    const hasUrls = urlPattern.test(text);

    return !!phoneNumber && (mediaIntent || hasUrls);
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

      // Extract URLs from the message
      const urlPattern = /https?:\/\/[^\s]+/g;
      const mediaUrls: string[] = text.match(urlPattern) || [];

      if (mediaUrls.length === 0) {
        // If no URLs found but MMS was requested, use a default demo image
        mediaUrls.push("https://demo.twilio.com/owl.png");
      }

      // Extract the message content
      let messageContent = text
        .replace(phoneNumber, "")
        .replace(/send\s*(an?\s*)?(mms|picture|photo|image|video|media)\s*(to\s*)?/gi, "")
        .replace(/with\s*(the\s*)?(image|photo|picture|video|media|mms)/gi, "")
        .replace(/at|from/gi, "")
        .replace(urlPattern, "") // Remove URLs from message
        .replace(/saying|with\s*(the\s*)?(message|text)/gi, "")
        .trim();

      // Remove quotes if present
      messageContent = messageContent.replace(/^["']|["']$/g, "").trim();

      // If no message content extracted, use a default
      if (!messageContent) {
        messageContent = "Here's the media you requested";
      }

      // Validate phone number
      if (!validateMessagingAddress(phoneNumber)) {
        throw new Error("Invalid phone number format");
      }

      // Send the MMS
      const sentMessage = await twilioService.sendSms(phoneNumber, messageContent, mediaUrls);
      logger.info(`MMS sent to ${phoneNumber} with ${mediaUrls.length} media attachment(s)`);

      if (callback) {
        callback({
          text: `MMS sent successfully to ${phoneNumber} with ${mediaUrls.length} media attachment(s)`,
          success: true,
        });
      }
    } catch (error) {
      logger.error({ error: String(error) }, "Error sending MMS");
      if (callback) {
        callback({
          text: `Failed to send MMS: ${error instanceof Error ? error.message : "Unknown error"}`,
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
          text: "Send a picture to +18885551234 with the image from https://example.com/photo.jpg saying 'Check out this photo!'",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll send that photo with your message.",
          action: "SEND_MMS",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Send an MMS to +15555551234 with the video at https://example.com/video.mp4",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Sending the video message now.",
          action: "SEND_MMS",
        },
      },
    ],
  ],
  similes: [
    "send mms",
    "send picture",
    "send photo",
    "send image",
    "send video",
    "send media",
    "picture message",
    "photo message",
  ],
};

export default sendMmsAction;
