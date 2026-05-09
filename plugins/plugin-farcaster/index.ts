import { getConnectorAccountManager, logger, type Plugin } from "@elizaos/core";
import { createFarcasterConnectorAccountProvider } from "./connector-account-provider";
import { farcasterProviders } from "./providers";
import { farcasterWebhookRoutes } from "./routes/webhook";
import { FarcasterService } from "./services/FarcasterService";

export { FarcasterClient } from "./client/FarcasterClient";
export {
  createFarcasterConnectorAccountProvider,
  FARCASTER_PROVIDER_ID,
} from "./connector-account-provider";
export {
  EmbedManager,
  isEmbedCast,
  isEmbedUrl,
  type ProcessedEmbed,
} from "./managers/EmbedManager";
export { FarcasterService } from "./services/FarcasterService";
export type {
  Cast,
  CastEmbed,
  CastId,
  FarcasterConfig,
  FarcasterEventTypes,
  FarcasterMessageType,
  FidRequest,
  Profile,
} from "./types";
export {
  DEFAULT_FARCASTER_ACCOUNT_ID,
  listFarcasterAccountIds,
  normalizeFarcasterAccountId,
  readFarcasterAccountId,
  resolveDefaultFarcasterAccountId,
} from "./utils/config";

export const farcasterPlugin: Plugin = {
  name: "farcaster",
  description: "Farcaster client plugin for sending and receiving casts",
  services: [FarcasterService],
  actions: [],
  providers: farcasterProviders,
  routes: farcasterWebhookRoutes,
  // Self-declared auto-enable: activate when the "farcaster" connector is
  // configured under config.connectors. The hardcoded CONNECTOR_PLUGINS map
  // in plugin-auto-enable-engine.ts still serves as a fallback.
  autoEnable: {
    connectorKeys: ["farcaster"],
  },
  async init(_config, runtime) {
    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createFarcasterConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:farcaster",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Farcaster provider with ConnectorAccountManager"
      );
    }
  },
};

export default farcasterPlugin;
