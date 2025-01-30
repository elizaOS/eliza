import { elizaLogger } from "@elizaos/core";
import { Client, IAgentRuntime } from "@elizaos/core";
import {TelegramAccountConfig, validateTelegramAccountConfig} from "./environment.ts";
import { TelegramAccountClient } from "./telegramAccountClient.ts"

export const TelegramAccountClientInterface: Client = {
    start: async (runtime: IAgentRuntime) => {
        const telegramAccountConfig: TelegramAccountConfig = await validateTelegramAccountConfig(runtime);
        const telegramAccountClient = new TelegramAccountClient(runtime, telegramAccountConfig);
        await telegramAccountClient.start();

        return telegramAccountClient;
    },
    stop: async (_runtime: IAgentRuntime) => {
        elizaLogger.warn("Telegram client does not support stopping yet");
    },
};

export default TelegramAccountClientInterface;
