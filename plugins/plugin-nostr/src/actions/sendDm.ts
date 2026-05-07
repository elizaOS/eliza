/**
 * Send DM action for Nostr plugin.
 */

import {
  type Action,
  type ActionResult,
  composePromptFromState,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import type { NostrService } from "../service.js";
import {
  isValidPubkey,
  NOSTR_SERVICE_NAME,
  normalizePubkey,
  splitMessageForNostr,
} from "../types.js";

interface SendDmParams {
  text: string;
  toPubkey: string;
}

const SEND_DM_TEMPLATE = `# Task: Extract Nostr DM parameters
Based on the conversation, determine what message to send and to whom.

Recent conversation:
{{recentMessages}}

Respond with JSON only, no prose or fences:

{
  "text": "message content here",
  "toPubkey": "npub1... or hex pubkey or current"
}
`;

export const sendDm: Action = {
  name: "NOSTR_SEND_DM",
  similes: ["SEND_NOSTR_DM", "NOSTR_MESSAGE", "NOSTR_TEXT", "DM_NOSTR"],
  description: "Send an encrypted direct message via Nostr (NIP-04)",
  descriptionCompressed: "send encrypt direct message via Nostr (NIP-04)",
  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    return message.content.source === "nostr";
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: (response: { text: string; source?: string }) => void
  ): Promise<ActionResult> => {
    const nostrService = runtime.getService<NostrService>(NOSTR_SERVICE_NAME);

    if (!nostrService?.isConnected()) {
      if (callback) {
        callback({ text: "Nostr service is not available.", source: "nostr" });
      }
      return { success: false, error: "Nostr service not available" };
    }

    // Get or compose state
    const currentState = state ?? (await runtime.composeState(message));

    // Compose prompt
    const prompt = await composePromptFromState({
      template: SEND_DM_TEMPLATE,
      state: currentState,
    });

    // Extract parameters using LLM
    let dmInfo: SendDmParams | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
      });

      const actionParams = parseJSONObjectFromText(String(response)) as Record<
        string,
        unknown
      > | null;
      if (actionParams?.text) {
        dmInfo = {
          text: String(actionParams.text),
          toPubkey: String(actionParams.toPubkey || "current"),
        };
        break;
      }
    }

    if (!dmInfo?.text) {
      if (callback) {
        callback({
          text: "I couldn't understand what message you want me to send. Please try again.",
          source: "nostr",
        });
      }
      return { success: false, error: "Could not extract message parameters" };
    }

    // Determine target pubkey
    let targetPubkey: string | undefined;
    if (dmInfo.toPubkey && dmInfo.toPubkey !== "current") {
      if (isValidPubkey(dmInfo.toPubkey)) {
        try {
          targetPubkey = normalizePubkey(dmInfo.toPubkey);
        } catch {
          // Invalid pubkey format
        }
      }
    }

    // Get pubkey from state context if available
    if (!targetPubkey && currentState?.data?.senderPubkey) {
      targetPubkey = currentState.data.senderPubkey as string;
    }

    if (!targetPubkey) {
      if (callback) {
        callback({
          text: "I couldn't determine who to send the message to. Please specify a pubkey.",
          source: "nostr",
        });
      }
      return { success: false, error: "Could not determine target pubkey" };
    }

    // Split message if too long
    const chunks = splitMessageForNostr(dmInfo.text);

    // Send message(s)
    let lastResult: { eventId?: string; relays?: string[] } | undefined;
    for (const chunk of chunks) {
      const result = await nostrService.sendDm({
        toPubkey: targetPubkey,
        text: chunk,
      });

      if (!result.success) {
        if (callback) {
          callback({
            text: `Failed to send message: ${result.error}`,
            source: "nostr",
          });
        }
        return { success: false, error: result.error };
      }

      lastResult = { eventId: result.eventId, relays: result.relays };
      logger.debug(`Sent Nostr DM: ${result.eventId}`);
    }

    if (callback) {
      callback({
        text: "Message sent successfully.",
        source: message.content.source as string,
      });
    }

    return {
      success: true,
      data: {
        toPubkey: targetPubkey,
        eventId: lastResult?.eventId,
        relays: lastResult?.relays,
        chunksCount: chunks.length,
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Send them a message saying 'Hello!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that DM via Nostr.",
          actions: ["NOSTR_SEND_DM"],
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Message npub1abc... saying 'Thanks for the zap!'" },
      },
      {
        name: "{{agent}}",
        content: {
          text: "I'll send that message to the specified pubkey.",
          actions: ["NOSTR_SEND_DM"],
        },
      },
    ],
  ],
};
