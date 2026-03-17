/**
 * Identity context provider for Nostr plugin.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { NostrService } from "../service.js";
import { NOSTR_SERVICE_NAME } from "../types.js";

export const identityContextProvider: Provider = {
  name: "nostrIdentityContext",
  description: "Provides information about the bot's Nostr identity",

  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
  ): Promise<ProviderResult> => {
    // Only provide context for Nostr messages
    if (message.content.source !== "nostr") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const nostrService = await runtime.getService<NostrService>(NOSTR_SERVICE_NAME);

    if (!nostrService || !nostrService.isConnected()) {
      return {
        data: { connected: false },
        values: { connected: false },
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";
    const publicKey = nostrService.getPublicKey();
    const npub = nostrService.getNpub();
    const relays = nostrService.getRelays();

    const responseText =
      `${agentName} is connected to Nostr with pubkey ${npub}. ` +
      `Connected to ${relays.length} relay(s): ${relays.join(", ")}. ` +
      `Nostr is a decentralized social protocol using cryptographic keys for identity.`;

    return {
      data: {
        publicKey,
        npub,
        relays,
        relayCount: relays.length,
        connected: true,
      },
      values: {
        publicKey,
        npub,
        relayCount: relays.length,
      },
      text: responseText,
    };
  },
};
