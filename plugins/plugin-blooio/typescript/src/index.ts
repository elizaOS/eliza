import { type IAgentRuntime, logger, type Plugin } from "@elizaos/core";
import sendMessageAction from "./actions/sendMessage";
import conversationHistoryProvider from "./providers/conversationHistory";
import { BlooioService } from "./service";
import { BlooioTestSuite } from "./tests";

const blooioPlugin: Plugin = {
  name: "blooio",
  description: "Blooio plugin for iMessage/SMS messaging integration",
  services: [BlooioService],
  actions: [sendMessageAction],
  providers: [conversationHistoryProvider],
  tests: [new BlooioTestSuite()],
  init: async (_config: Record<string, string>, runtime: IAgentRuntime) => {
    const apiKey = runtime.getSetting("BLOOIO_API_KEY") as string;
    const webhookUrl = runtime.getSetting("BLOOIO_WEBHOOK_URL") as string;
    const webhookSecret = runtime.getSetting("BLOOIO_WEBHOOK_SECRET") as string;

    if (!apiKey || apiKey.trim() === "") {
      logger.warn(
        "Blooio API key not provided - Blooio plugin is loaded but will not be functional"
      );
      logger.warn(
        "To enable Blooio functionality, please provide BLOOIO_API_KEY in your .env file"
      );
      return;
    }

    if (!webhookUrl || webhookUrl.trim() === "") {
      logger.warn("Blooio webhook URL not provided - Blooio will not receive incoming messages");
      logger.warn(
        "To enable incoming communication, please provide BLOOIO_WEBHOOK_URL in your .env file"
      );
      return;
    }

    if (!webhookSecret || webhookSecret.trim() === "") {
      logger.warn("Blooio webhook secret not provided - signature verification is disabled");
    }

    logger.info("Blooio plugin initialized successfully");
  },
};

export default blooioPlugin;
