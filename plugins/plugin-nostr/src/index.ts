/**
 * Nostr Plugin for ElizaOS
 *
 * Provides Nostr decentralized messaging integration for ElizaOS agents,
 * supporting encrypted DMs via NIP-04 and profile management.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { getConnectorAccountManager, logger } from "@elizaos/core";
import { createNostrConnectorAccountProvider } from "./connector-account-provider.js";
import { identityContextProvider } from "./providers/index.js";
import { NostrService } from "./service.js";
import { DEFAULT_NOSTR_RELAYS } from "./types.js";

export * from "./accounts.js";
// Export types
export * from "./types.js";
// Export service / providers / actions
// Nostr DMs route through MESSAGE. Public notes route through POST. Profile
// publishing is connector-owned identity metadata, not a planner action.
export { identityContextProvider, NostrService };
export { publishProfile } from "./actions/index.js";

/**
 * Nostr plugin definition
 */
const nostrPlugin: Plugin = {
  name: "nostr",
  description: "Nostr decentralized messaging plugin for ElizaOS agents",

  services: [NostrService],

  actions: [],

  providers: [identityContextProvider],

  tests: [],

  // Self-declared auto-enable: activate when the "nostr" connector is
  // configured under config.connectors. The hardcoded CONNECTOR_PLUGINS map
  // in plugin-auto-enable-engine.ts still serves as a fallback.
  autoEnable: {
    connectorKeys: ["nostr"],
  },

  /**
   * Plugin initialization hook
   */
  init: async (config: Record<string, string>, runtime: IAgentRuntime): Promise<void> => {
    logger.info("Initializing Nostr plugin...");

    try {
      const manager = getConnectorAccountManager(runtime);
      manager.registerProvider(createNostrConnectorAccountProvider(runtime));
    } catch (err) {
      logger.warn(
        {
          src: "plugin:nostr",
          err: err instanceof Error ? err.message : String(err),
        },
        "Failed to register Nostr provider with ConnectorAccountManager"
      );
    }

    // Log configuration status
    const hasPrivateKey = Boolean(config.NOSTR_PRIVATE_KEY || process.env.NOSTR_PRIVATE_KEY);
    const relaysRaw = config.NOSTR_RELAYS || process.env.NOSTR_RELAYS || "";
    const relays = relaysRaw ? relaysRaw.split(",").length : DEFAULT_NOSTR_RELAYS.length;

    logger.info(`Nostr plugin configuration:`);
    logger.info(`  - Private key configured: ${hasPrivateKey ? "Yes" : "No"}`);
    logger.info(`  - Relays: ${relays} relay(s)`);
    logger.info(
      `  - DM policy: ${config.NOSTR_DM_POLICY || process.env.NOSTR_DM_POLICY || "pairing"}`
    );

    if (!hasPrivateKey) {
      logger.warn("Nostr private key not configured. Set NOSTR_PRIVATE_KEY (hex or nsec format).");
    }

    logger.info("Nostr plugin initialized");
  },
};

export default nostrPlugin;
