/** Worker-safe Network plugin bound to host-owned stores and turn authority. */
import type { Plugin } from "@elizaos/core";
import { createSetStateAction } from "./actions/set-state.js";
import { createNetworkSignalsEvaluator } from "./evaluators/network-signals.js";
import { createMemberContextProvider } from "./providers/member-context.js";
import { NETWORK_CONTEXT_DEFINITION } from "./routing/context.js";
import { createNetworkActionFieldEvaluator } from "./routing/structured-field.js";
import type { NetworkStore, NetworkTurnAuthority } from "./types.js";

export const NETWORK_EDGE_COMPATIBILITY = {
  target: "edge",
  state: "host-injected",
  effects: ["network-store-read", "network-store-write"],
  requiredBindings: [],
  requiredSecrets: [],
} as const;

/** How a Network turn routes availability changes; see `routing` below. */
export type NetworkRouting = "planner" | "structured";

export interface NetworkEdgePluginOptions {
  store: NetworkStore;
  authority: NetworkTurnAuthority;
  /** Default true. Set false for system/lifecycle turns (zero actions). */
  actionsEnabled?: boolean;
  /**
   * How availability changes are routed. Both designs register the `network`
   * context so Stage 1 can route to it (Stage 1 only offers registered
   * contexts backed by an action or provider).
   * - "planner" (design A): Stage 1 routes to `network` and the planner calls
   *   SET_STATE; the host adds a must-call-SET_STATE requirement for detected
   *   availability intents, like REMINDERS and TODO.
   * - "structured" (design B): a `networkAction` field on the same Stage-1
   *   call proposes the change; deterministic code authorizes and executes it
   *   through the store and preempts the planner with a direct reply.
   */
  routing?: NetworkRouting;
}

export function createNetworkEdgePlugin(options: NetworkEdgePluginOptions): Plugin {
  const actionsEnabled = options.actionsEnabled ?? true;
  const routing = options.routing ?? "planner";
  return {
    name: "network-edge",
    description: "The Network: member context, availability state and post-turn signals.",
    contexts: ["network"],
    init: async (_config, runtime) => {
      runtime.contexts.tryRegister(NETWORK_CONTEXT_DEFINITION);
    },
    ...(actionsEnabled && routing === "structured"
      ? {
          responseHandlerFieldEvaluators: [
            createNetworkActionFieldEvaluator({
              store: options.store,
              authority: options.authority,
            }),
          ],
        }
      : {}),
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
