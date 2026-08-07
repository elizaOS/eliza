/**
 * Plugin entry: assembles the Telegram `Plugin` object — the `TelegramService`
 * and `TelegramOwnerPairingServiceImpl` (in that order), the bot- and
 * user-account setup routes, and the live test suite — and, on `init`, wires the
 * ConnectorAccountManager provider, the DM sensitive-request adapter, and the
 * cross-connector triage adapter. Auto-enables on the `telegram` connector key.
 */
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
import { TelegramStandaloneService } from "./standalone/service";
import { TelegramTestSuite } from "./tests";
import { registerTelegramTriageAdapter } from "./triage-adapter";

const telegramPlugin: Plugin = {
  name: TELEGRAM_SERVICE_NAME,
  description: "Telegram client plugin",
  connectorSources: [
    {
      source: "telegram",
      aliases: ["telegram", "telegram-account", "telegramaccount"],
      sourceKind: "passive",
      isPassive: true,
      identityMetadataMapping: {
        userIdField: "fromId",
        nameField: "entityName",
      },
      worldIdMetadataKeys: ["telegramChatId"],
    },
  ],
  // TelegramService must come before TelegramOwnerPairingServiceImpl so the
  // bot instance exists when the pairing service registers its command.
  // TelegramStandaloneService is the opt-in standalone long-poll mode: it
  // self-gates on ELIZA_TELEGRAM_STANDALONE_BOT (with LifeOps passive
  // connectors disabled) and stays dormant otherwise, so the full connector
  // and the standalone bot are two modes of this one plugin.
  services: [
    TelegramService,
    TelegramOwnerPairingServiceImpl,
    TelegramStandaloneService,
  ],
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

    // Register the cross-connector triage adapter for the "telegram" source.
    registerTelegramTriageAdapter();
  },
  async dispose(runtime: IAgentRuntime) {
    await TelegramService.stop(runtime);
    await TelegramStandaloneService.stop(runtime);
  },
};

export * from "./account-auth-service";
export * from "./accounts";
export * from "./connector-account-provider";
export * from "./local-client";
export type { TelegramStandaloneContext } from "./standalone/handler";
export { handleTelegramStandaloneMessage } from "./standalone/handler";
export { shouldStartTelegramStandaloneBot } from "./standalone/policy";
export {
  TELEGRAM_STANDALONE_SERVICE_NAME,
  TelegramStandaloneService,
} from "./standalone/service";
export {
  MessageManager,
  stopTelegramAccountAuthSession,
  TELEGRAM_OWNER_PAIRING_SERVICE_TYPE,
  type TelegramOwnerPairingService,
  TelegramOwnerPairingServiceImpl,
  TelegramService,
};
export default telegramPlugin;
