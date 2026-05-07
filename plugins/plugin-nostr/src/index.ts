/**
 * Nostr Plugin for ElizaOS
 *
 * Provides Nostr decentralized messaging integration for ElizaOS agents,
 * supporting encrypted DMs via NIP-04 and profile management.
 */

import type { IAgentRuntime, Plugin } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { publishNote, publishProfile } from "./actions/index.js";
import { identityContextProvider } from "./providers/index.js";
import { NostrService } from "./service.js";
import { DEFAULT_NOSTR_RELAYS } from "./types.js";

// Export types
export * from "./types.js";
// Export service / providers / actions
// NOSTR_SEND_DM was a standalone action that duplicated the MessageConnector
// path. The Nostr DM connector (registered by NostrService.registerSendHandlers)
// is now the canonical send path; SEND_MESSAGE routes through it. Public
// publishing actions (publishNote, publishProfile) stay since they're not
// DM-shaped.
export { identityContextProvider, NostrService, publishNote, publishProfile };

/**
 * Nostr plugin definition
 */
const nostrPlugin: Plugin = {
  name: "nostr",
  description: "Nostr decentralized messaging plugin for ElizaOS agents",

  services: [NostrService],

  actions: [publishNote, publishProfile],

  providers: [identityContextProvider],

  tests: [],

  /**
   * Plugin initialization hook
   */
  init: async (config: Record<string, string>, _runtime: IAgentRuntime): Promise<void> => {
    logger.info("Initializing Nostr plugin...");

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
