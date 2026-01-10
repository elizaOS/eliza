import type { Plugin } from '@elizaos/core';
import { TELEGRAM_SERVICE_NAME } from './constants';
import { TelegramService } from './service';
import { TelegramTestSuite } from './tests';
import { MessageManager } from './messageManager';

const telegramPlugin: Plugin = {
  name: TELEGRAM_SERVICE_NAME,
  description: 'Telegram client plugin',
  services: [TelegramService],
  tests: [new TelegramTestSuite()],
};

export { TelegramService, MessageManager };
export default telegramPlugin;
