/**
 * Identity context provider for Nostr plugin.
 */

import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { NostrService } from "../service.js";
import { NOSTR_SERVICE_NAME } from "../types.js";

const MAX_RELAYS_IN_STATE = 12;

export const identityContextProvider: Provider = {
  name: "nostrIdentityContext",
  description: "Provides information about the bot's Nostr identity",
  descriptionCompressed: "provide information bot Nostr identity",
  dynamic: true,
  contextGate: { anyOf: ["social", "connectors"] },
  cacheStable: false,
  cacheScope: "turn",
  contexts: ["social", "connectors"],
  get: async (runtime: IAgentRuntime, message: Memory, state: State): Promise<ProviderResult> => {
    // Only provide context for Nostr messages
    if (message.content.source !== "nostr") {
      return {
        data: {},
        values: {},
        text: "",
      };
    }

    const nostrService = runtime.getService<NostrService>(NOSTR_SERVICE_NAME);

    if (!nostrService?.isConnected()) {
      return {
        data: { connected: false },
        values: { connected: false },
        text: "",
      };
    }

    const agentName = state?.agentName || "The agent";
    try {
      const publicKey = nostrService.getPublicKey();
      const npub = nostrService.getNpub();
      const relays = nostrService.getRelays();
      const shownRelays = relays.slice(0, MAX_RELAYS_IN_STATE);
      const truncated = relays.length > shownRelays.length;

      const responseText =
        `${agentName} is connected to Nostr with pubkey ${npub}. ` +
        `Connected to ${relays.length} relay(s): ${shownRelays.join(", ")}${truncated ? " ..." : ""}. ` +
        `Nostr is a decentralized social protocol using cryptographic keys for identity.`;

      return {
        data: {
          publicKey,
          npub,
          relays: shownRelays,
          relayCount: relays.length,
          shownRelayCount: shownRelays.length,
          truncated,
          connected: true,
        },
        values: {
          publicKey,
          npub,
          relayCount: relays.length,
        },
        text: responseText,
      };
    } catch (error) {
      return {
        data: { connected: false, error: error instanceof Error ? error.message : String(error) },
        values: { connected: false },
        text: "",
      };
    }
  },
};
