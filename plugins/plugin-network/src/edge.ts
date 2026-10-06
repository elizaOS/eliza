/** Worker-safe Network plugin bound to host-owned stores and turn authority. */
import type { Plugin } from "@elizaos/core";
import { createSetStateAction } from "./actions/set-state.js";
import { createNetworkSignalsEvaluator } from "./evaluators/network-signals.js";
import { createMemberContextProvider } from "./providers/member-context.js";
import type { NetworkStore, NetworkTurnAuthority } from "./types.js";

export const NETWORK_EDGE_COMPATIBILITY = {
  target: "edge",
  state: "host-injected",
  effects: ["network-store-read", "network-store-write"],
  requiredBindings: [],
  requiredSecrets: [],
} as const;

export interface NetworkEdgePluginOptions {
  store: NetworkStore;
  authority: NetworkTurnAuthority;
  /** Default true. Set false for system/lifecycle turns (zero actions). */
  actionsEnabled?: boolean;
}

export function createNetworkEdgePlugin(options: NetworkEdgePluginOptions): Plugin {
  const actionsEnabled = options.actionsEnabled ?? true;
  return {
    name: "network-edge",
    description: "The Network: member context, availability state and post-turn signals.",
    providers: [
      createMemberContextProvider({ store: options.store, authority: options.authority }),
    ],
    actions: actionsEnabled
      ? [createSetStateAction({ store: options.store, authority: options.authority })]
      : [],
    evaluators: [
      createNetworkSignalsEvaluator({
        store: options.store,
        authority: options.authority,
      }),
    ],
  };
}
