/**
 * Sender context provider for Nostr plugin.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import type { NostrService } from "../service.js";
import {
  getPubkeyDisplayName,
  NOSTR_SERVICE_NAME,
  pubkeyToNpub,
} from "../types.js";

export const senderContextProvider: Provider = {
  name: "nostrSenderContext",
  description:
    "Provides information about the Nostr user in the current conversation",

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

    // Get sender pubkey from state if available
    const senderPubkey = state?.data?.senderPubkey as string | undefined;

    if (!senderPubkey) {
      return {
        data: { connected: true },
        values: { connected: true },
        text: "",
      };
    }

    let senderNpub = "";
    try {
      senderNpub = pubkeyToNpub(senderPubkey);
    } catch {
      // Use hex if npub conversion fails
    }

    const displayName = getPubkeyDisplayName(senderPubkey);

    const responseText =
      `${agentName} is talking to ${displayName} on Nostr. ` +
      `Their pubkey is ${senderNpub || senderPubkey}. ` +
      `This is an encrypted direct message conversation using NIP-04.`;

    return {
      data: {
        senderPubkey,
        senderNpub,
        displayName,
        isEncrypted: true,
      },
      values: {
        senderPubkey,
        senderNpub,
        displayName,
      },
      text: responseText,
    };
  },
};
