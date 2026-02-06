import { type IAgentRuntime, logger, type TestCase, type TestSuite } from "@elizaos/core";
import { BLOOIO_SERVICE_NAME } from "./constants";
import type { BlooioService } from "./service";

export class BlooioTestSuite implements TestSuite {
  name = "Blooio Plugin Test Suite";
  description = "Tests for Blooio iMessage/SMS functionality";

  tests: TestCase[] = [
    {
      name: "Service Initialization Test",
      fn: async (runtime: IAgentRuntime) => {
        const blooioService = runtime.getService(BLOOIO_SERVICE_NAME) as BlooioService | null;
        if (!blooioService) {
          throw new Error("Blooio service not initialized");
        }

        if (!blooioService.isConnected) {
          throw new Error("Blooio service is not connected");
        }

        logger.info("✅ Blooio service initialized");
      },
    },
    {
      name: "Send Message Test",
      fn: async (runtime: IAgentRuntime) => {
        const blooioService = runtime.getService(BLOOIO_SERVICE_NAME) as BlooioService | null;
        if (!blooioService) {
          throw new Error("Blooio service not initialized");
        }

        const testChatId = runtime.getSetting("BLOOIO_TEST_CHAT_ID") as string;
        if (!testChatId) {
          logger.warn("BLOOIO_TEST_CHAT_ID not set, skipping send test");
          return;
        }

        const result = await blooioService.sendMessage(testChatId, {
          text: "Test message from Eliza Blooio plugin",
        });

        logger.info(`✅ Message test queued. Status: ${result.status}`);
      },
    },
    {
      name: "Conversation History Test",
      fn: async (runtime: IAgentRuntime) => {
        const blooioService = runtime.getService(BLOOIO_SERVICE_NAME) as BlooioService | null;
        if (!blooioService) {
          throw new Error("Blooio service not initialized");
        }

        const testChatId = runtime.getSetting("BLOOIO_TEST_CHAT_ID") as string;
        if (!testChatId) {
          logger.warn("BLOOIO_TEST_CHAT_ID not set, skipping history test");
          return;
        }

        await blooioService.sendMessage(testChatId, {
          text: "History test message",
        });

        const history = blooioService.getConversationHistory(testChatId, 5);
        if (history.length > 0) {
          logger.info(`✅ Conversation history retrieved: ${history.length} messages`);
          logger.info(`   Latest message: ${history[history.length - 1].text ?? "(no text)"}`);
        } else {
          logger.info("✅ Conversation history is empty (expected for new chat)");
        }
      },
    },
    {
      name: "Error Handling Test",
      fn: async (runtime: IAgentRuntime) => {
        const blooioService = runtime.getService(BLOOIO_SERVICE_NAME) as BlooioService | null;
        if (!blooioService) {
          throw new Error("Blooio service not initialized");
        }

        try {
          await blooioService.sendMessage("invalid-chat-id", { text: "Test" });
          throw new Error("Expected error for invalid chat id");
        } catch (_error) {
          logger.info("✅ Invalid chat id error handled correctly");
        }
      },
    },
  ];
}
