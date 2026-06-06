import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

import { INBOX_CONTEXTS } from "../types.ts";

/**
 * CROSS_CHANNEL_CONTEXT provider — surfaces the most-recent activity for the
 * counterparty in the current conversation across every other channel they
 * appear on (so the agent can say "you replied to Sam on Discord last week").
 *
 * MIGRATION STATUS: STUB.
 * Reference: plugins/plugin-personal-assistant/src/providers/cross-channel-context.ts
 */
export const crossChannelContextProvider: Provider = {
  name: "CROSS_CHANNEL_CONTEXT",
  description:
    "Recent activity for the current counterparty across every other connected inbox channel.",
  position: -3,
  contexts: [...INBOX_CONTEXTS],
  contextGate: { anyOf: [...INBOX_CONTEXTS] },
  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    // TODO: port from plugins/plugin-personal-assistant/src/providers/cross-channel-context.ts.
    return { text: "", data: { history: [] } };
  },
};

export default crossChannelContextProvider;
