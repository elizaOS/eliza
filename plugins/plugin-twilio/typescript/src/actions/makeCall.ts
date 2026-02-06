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
import { MakeCallSchema } from "../types";
import { extractPhoneNumber, generateTwiML, validatePhoneNumber } from "../utils";

const makeCallAction: Action = {
  name: "MAKE_CALL",
  description: "Make a phone call via Twilio with a message or custom TwiML",
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    // Check if Twilio service is available
    const twilioService = runtime.getService(TWILIO_SERVICE_NAME);
    if (!twilioService) {
      logger.error("Twilio service not found");
      return false;
    }

    // Check if message contains phone number and call intent
    const text = message.content.text || "";
    const phoneNumber = extractPhoneNumber(text);
    const callIntent =
      text.toLowerCase().includes("call") ||
      text.toLowerCase().includes("phone") ||
      text.toLowerCase().includes("dial");

    return !!phoneNumber && callIntent;
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

      // Extract the call message content
      // Remove the phone number and command keywords from the text
      let callMessage = text
        .replace(phoneNumber, "")
        .replace(/call|phone|dial/gi, "")
        .replace(/and\s*say/gi, "")
        .replace(/with\s*(the\s*)?(message|saying)/gi, "")
        .trim();

      // Remove quotes if present
      callMessage = callMessage.replace(/^["']|["']$/g, "").trim();

      // If no message content extracted, use a default
      if (!callMessage) {
        callMessage = "Hello, this is an automated call from your AI assistant.";
      }

      // Validate phone number
      if (!validatePhoneNumber(phoneNumber)) {
        throw new Error("Invalid phone number format");
      }

      // Generate TwiML for the call
      const twiml = generateTwiML.say(callMessage);

      // Make the call
      const call = await twilioService.makeCall(phoneNumber, twiml);
      logger.info(`Call initiated to ${phoneNumber}, Call SID: ${call.sid}`);

      if (callback) {
        callback({
          text: `Call initiated successfully to ${phoneNumber}. Call ID: ${call.sid}`,
          success: true,
        });
      }
    } catch (error) {
      logger.error({ error: String(error) }, "Error making call");
      if (callback) {
        callback({
          text: `Failed to make call: ${error instanceof Error ? error.message : "Unknown error"}`,
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
          text: "Call +18885551234 and say 'This is an important reminder about your appointment tomorrow at 3pm'",
        },
      },
      {
        name: "assistant",
        content: {
          text: "I'll place that call with your reminder message.",
          action: "MAKE_CALL",
        },
      },
    ],
    [
      {
        name: "user",
        content: {
          text: "Phone +15555551234 with an automated message about the meeting cancellation",
        },
      },
      {
        name: "assistant",
        content: {
          text: "Initiating the call with the cancellation message.",
          action: "MAKE_CALL",
        },
      },
    ],
  ],
  similes: ["make call", "phone call", "call phone", "dial number", "voice call", "ring phone"],
};

export default makeCallAction;
