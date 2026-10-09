/**
 * GET_UPDATES: the member asks what's new ("updates", "anything from the Network?"). Read-only for
 * the member's data; it marks the returned inbox items seen everywhere (single inbox, entry-flows
 * doc 5.1), so the scheduler cancels any text still waiting for them. Member identity comes from
 * host authority, never from parameters. Registered only when the store implements readUpdates.
 */
import type {
  Action,
  ActionResult,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import {
  NETWORK_CONTEXTS,
  type NetworkStore,
  type NetworkTurnAuthority,
} from "../types.js";

export interface GetUpdatesActionOptions {
  store: NetworkStore & Required<Pick<NetworkStore, "readUpdates">>;
  authority: NetworkTurnAuthority;
  roleGate?: Action["roleGate"];
}

export const MAX_UPDATES_IN_REPLY = 5;

export function createGetUpdatesAction(
  options: GetUpdatesActionOptions,
): Action {
  return {
    name: "GET_UPDATES",
    description:
      "Show the member's new Network updates (introductions, plans, questions, reminders) and mark them seen.",
    descriptionCompressed: "network: list member's unseen updates",
    routingHint:
      "member asks what's new, for updates, or replies to a Network text asking to see it -> GET_UPDATES",
    contexts: [...NETWORK_CONTEXTS],
    contextGate: { anyOf: [...NETWORK_CONTEXTS] },
    roleGate: options.roleGate ?? { minRole: "GUEST" },
    tags: ["domain:network", "capability:read"],
    similes: ["NETWORK_UPDATES", "WHATS_NEW", "SHOW_UPDATES"],
    parameters: [],
    validate: async () => true,
    handler: async (
      _runtime: IAgentRuntime,
      _message: Memory,
    ): Promise<ActionResult> => {
      const { items } = await options.store.readUpdates(
        options.authority.memberId,
      );
      const shown = items
        .slice(0, MAX_UPDATES_IN_REPLY)
        .map((i) => i.summary.trim())
        .filter(Boolean);
      const more = items.length - shown.length;
      return {
        success: true,
        text:
          shown.length === 0
            ? "No new Network updates."
            : `Network updates:\n${shown.map((s) => `- ${s}`).join("\n")}${more > 0 ? `\n(+${more} more)` : ""}`,
        modelReplyRequired: true,
        data: { actionName: "GET_UPDATES", count: items.length },
      };
    },
  };
}
