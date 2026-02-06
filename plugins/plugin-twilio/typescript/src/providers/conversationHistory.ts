import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { TWILIO_SERVICE_NAME } from "../constants";
import type { TwilioService } from "../service";

const conversationHistoryProvider: Provider = {
  name: "twilioConversationHistory",
  description: "Provides recent SMS/MMS conversation history with a phone number",
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    try {
      const twilioService = runtime.getService(TWILIO_SERVICE_NAME) as unknown as TwilioService;
      if (!twilioService) {
        return {
          text: "No Twilio conversation history available - service not initialized",
        };
      }

      // Extract phone number from the current context
      if (typeof message.content === "string") {
        return {
          text: "No phone number found in context",
        };
      }

      const phoneNumber =
        message.content.phoneNumber || message.content.text?.match(/\+?\d{10,15}/)?.[0];

      if (!phoneNumber || typeof phoneNumber !== "string") {
        return {
          text: "No phone number found in context",
        };
      }

      // Get conversation history using the public method
      const conversationHistory = twilioService.getConversationHistory(phoneNumber, 10);

      if (!conversationHistory || conversationHistory.length === 0) {
        return {
          text: `No recent conversation history with ${phoneNumber}`,
        };
      }

      // Format conversation history
      const history = conversationHistory
        .map((msg: any) => {
          const direction = msg.direction === "inbound" ? "From" : "To";
          const time = new Date(msg.dateCreated).toLocaleString();
          return `[${time}] ${direction} ${phoneNumber}: ${msg.body}`;
        })
        .join("\n");

      return {
        text: `Recent SMS conversation with ${phoneNumber}:\n${history}`,
        data: {
          phoneNumber,
          messageCount: conversationHistory.length,
          lastMessage: conversationHistory[conversationHistory.length - 1],
        },
      };
    } catch (error) {
      console.error("Error in conversationHistoryProvider:", error);
      return {
        text: "Error retrieving conversation history",
      };
    }
  },
};

export default conversationHistoryProvider;
