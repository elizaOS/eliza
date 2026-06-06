import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

import { INBOX_CONTEXTS } from "../types.ts";

/**
 * INBOX_TRIAGE provider — injects the user's unresolved inbox triage queue
 * into the planner each turn.
 *
 * MIGRATION STATUS: STUB.
 * Reference: plugins/plugin-lifeops/src/providers/inbox-triage.ts
 *
 * The real provider reads the cross-channel triage repository and emits a
 * compact markdown summary of unresolved + needs_approval threads. The full
 * implementation will be ported here in a follow-up pass.
 */
export const inboxTriageProvider: Provider = {
  name: "INBOX_TRIAGE",
  description:
    "The user's pending cross-channel inbox triage queue — unresolved threads, snoozed wakeups, and decisions awaiting approval.",
  position: -4,
  contexts: [...INBOX_CONTEXTS],
  contextGate: { anyOf: [...INBOX_CONTEXTS] },
  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    // TODO: port from plugins/plugin-lifeops/src/providers/inbox-triage.ts.
    return { text: "", data: { threads: [] } };
  },
};

export default inboxTriageProvider;
