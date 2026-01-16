import type { Plugin, TestSuite } from "@elizaos/core";
import { SEND_MESSAGE_ACTION, sendMessageAction } from "./actions";
import { TELEGRAM_SERVICE_NAME } from "./constants";
import { MessageManager } from "./messageManager";
import { CHAT_STATE_PROVIDER, chatStateProvider } from "./providers";
import { TelegramService } from "./service";
import { TelegramTestSuite } from "./tests";

const telegramPlugin: Plugin = {
  name: TELEGRAM_SERVICE_NAME,
  description: "Telegram client plugin",
  services: [TelegramService],
  actions: [sendMessageAction],
  providers: [chatStateProvider],
  tests: [new TelegramTestSuite() as unknown as TestSuite],
};

export {
  TelegramService,
  MessageManager,
  sendMessageAction,
  SEND_MESSAGE_ACTION,
  chatStateProvider,
  CHAT_STATE_PROVIDER,
};
export default telegramPlugin;
