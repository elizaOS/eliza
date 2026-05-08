import type { Plugin } from '@elizaos/core';
import {
  stopTelegramAccountAuthSession,
  telegramAccountRoutes,
} from './account-setup-routes';
import { TELEGRAM_SERVICE_NAME } from './constants';
import { MessageManager } from './messageManager';
import {
  TELEGRAM_OWNER_PAIRING_SERVICE_TYPE,
  TelegramOwnerPairingServiceImpl,
  type TelegramOwnerPairingService,
} from './owner-pairing-service';
import { TelegramService } from './service';
import { telegramSetupRoutes } from './setup-routes';
import { TelegramTestSuite } from './tests';

const telegramPlugin: Plugin = {
  name: TELEGRAM_SERVICE_NAME,
  description: 'Telegram client plugin',
  // TelegramService must come before TelegramOwnerPairingServiceImpl so the
  // bot instance exists when the pairing service registers its command.
  services: [TelegramService, TelegramOwnerPairingServiceImpl],
  routes: [...telegramSetupRoutes, ...telegramAccountRoutes],
  tests: [new TelegramTestSuite()],
  // Self-declared auto-enable: activate when the "telegram" connector is
  // configured in eliza.json / eliza.json. The hardcoded CONNECTOR_PLUGINS
  // map in plugin-auto-enable.ts still serves as a fallback.
  autoEnable: {
    connectorKeys: ['telegram'],
  },
};

export {
  MessageManager,
  stopTelegramAccountAuthSession,
  TELEGRAM_OWNER_PAIRING_SERVICE_TYPE,
  TelegramOwnerPairingServiceImpl,
  TelegramService,
  type TelegramOwnerPairingService,
};
export * from './account-auth-service';
export * from './accounts';
export default telegramPlugin;
