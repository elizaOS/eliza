import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import {
  stopTelegramAccountAuthSession,
  telegramAccountRoutes,
} from "./account-setup-routes";
import { createTelegramConnectorAccountProvider } from "./connector-account-provider";
import { TELEGRAM_SERVICE_NAME } from "./constants";
import { MessageManager } from "./messageManager";
import {
  TELEGRAM_OWNER_PAIRING_SERVICE_TYPE,
  type TelegramOwnerPairingService,
  TelegramOwnerPairingServiceImpl,
} from "./owner-pairing-service";
import { registerTelegramDmSensitiveRequestAdapter } from "./sensitive-request-adapter";
import { TelegramService } from "./service";
import { telegramSetupRoutes } from "./setup-routes";
import { TelegramTestSuite } from "./tests";

const telegramPlugin: Plugin = {
  name: TELEGRAM_SERVICE_NAME,
  description: "Telegram client plugin",
  connectorSources: [
    {
      source: "telegram",
      aliases: ["telegram", "telegram-account", "telegramaccount"],
      sourceKind: "passive",
      isPassive: true,
    },
  ],
  // TelegramService must come before TelegramOwnerPairingServiceImpl so the
  // bot instance exists when the pairing service registers its command.
  services: [TelegramService, TelegramOwnerPairingServiceImpl],
  routes: [...telegramSetupRoutes, ...telegramAccountRoutes],
  tests: [new TelegramTestSuite()],
  // Self-declared auto-enable: activate when the "telegram" connector is
  // configured in eliza.json / eliza.json. The hardcoded CONNECTOR_PLUGINS
  // map in plugin-auto-enable.ts still serves as a fallback.
  autoEnable: {
    connectorKeys: ["telegram"],
  },
  init: async (
    _config: Record<string, string>,
    runtime: IAgentRuntime,
  ): Promise<void> => {
    // Register with the ConnectorAccountManager so the generic HTTP CRUD
    // surface can list, create, patch, and delete Telegram accounts. Telegram
    // has no OAuth flow; only CRUD adapters are wired.
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createTelegramConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:telegram",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Telegram provider with ConnectorAccountManager",
      );
    }

    // Deliver secret / OAuth requests as a DM link-out (the value never transits
    // the chat transport). Mirrors the Discord DM adapter.
    registerTelegramDmSensitiveRequestAdapter(runtime);
  },
  async dispose(runtime: IAgentRuntime) {
    await TelegramService.stop(runtime);
  },
};

export * from "./account-auth-service";
export * from "./accounts";
export * from "./connector-account-provider";
export * from "./local-client";
export {
  MessageManager,
  stopTelegramAccountAuthSession,
  TELEGRAM_OWNER_PAIRING_SERVICE_TYPE,
  type TelegramOwnerPairingService,
  TelegramOwnerPairingServiceImpl,
  TelegramService,
};
export default telegramPlugin;
