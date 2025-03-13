import type { Plugin } from "@elizaos/core";
import { TelegramService } from "./service";
import { TELEGRAM_SERVICE_NAME } from "./constants";
import { TelegramTestSuite } from "./tests";

const telegramPlugin: Plugin = {
	name: TELEGRAM_SERVICE_NAME,
	description: "Telegram client plugin",
	services: [TelegramService],
	tests: [new TelegramTestSuite()],
};
export default telegramPlugin;
