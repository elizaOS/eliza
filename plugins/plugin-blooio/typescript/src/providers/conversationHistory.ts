import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { BLOOIO_SERVICE_NAME } from "../constants";
import type { BlooioService } from "../service";

const conversationHistoryProvider: Provider = {
  name: "blooioConversationHistory",
  description: "Provides recent Blooio conversation history with a chat",
  get: async (runtime: IAgentRuntime, message: Memory, _state?: State) => {
    try {
      const blooioService = runtime.getService(BLOOIO_SERVICE_NAME) as BlooioService | null;
      if (!blooioService) {
        return {
          text: "No Blooio conversation history available - service not initialized",
        };
      }

      if (typeof message.content === "string") {
        return {
          text: "No chat identifier found in context",
        };
      }

      const chatId =
        typeof message.content?.chatId === "string"
          ? message.content.chatId
          : typeof message.content?.phoneNumber === "string"
            ? message.content.phoneNumber
            : message.content?.text?.match(
                /(\+\d{1,15}|grp_[A-Za-z0-9]+|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/
              )?.[0];

      if (!chatId || typeof chatId !== "string") {
        return {
          text: "No chat identifier found in context",
        };
      }

      const conversationHistory = blooioService.getConversationHistory(chatId, 10);
      if (!conversationHistory || conversationHistory.length === 0) {
        return {
          text: `No recent conversation history with ${chatId}`,
        };
      }

      const history = conversationHistory
        .map((msg) => {
          const direction = msg.direction === "inbound" ? "From" : "To";
          const time = new Date(msg.timestamp).toLocaleString();
          const text = msg.text ?? "(no text)";
          return `[${time}] ${direction} ${chatId}: ${text}`;
        })
        .join("\n");

      return {
        text: `Recent Blooio conversation with ${chatId}:\n${history}`,
        data: {
          chatId,
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
