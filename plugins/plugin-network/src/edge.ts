/** Worker-safe Network plugin bound to host-owned stores and turn authority. */
import type { Plugin } from "@elizaos/core";
import { createGetUpdatesAction } from "./actions/get-updates.js";
import { createRelayAction } from "./actions/relay.js";
import { createSetStateAction } from "./actions/set-state.js";
import type { NetworkAppId } from "./backend/contract.js";
import { createNetworkSignalsEvaluator } from "./evaluators/network-signals.js";
import { createNetworkVoiceProvider } from "./providers/agent-voice.js";
import { createMemberContextProvider } from "./providers/member-context.js";
import { NETWORK_CONTEXT_DEFINITION } from "./routing/context.js";
import { createNetworkActionFieldEvaluator } from "./routing/structured-field.js";
import type { NetworkStore, NetworkTurnAuthority } from "./types.js";

type GetUpdatesStore = NetworkStore &
  Required<Pick<NetworkStore, "readUpdates">>;
type RelayStore = NetworkStore & Required<Pick<NetworkStore, "relay">>;

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
  /** Clock for date resolution (tests and the simulator). Default: wall clock. */
  now?: () => Date;
  /**
   * The character flag: speak as The Network's agent with this app's voice (NETWORK_VOICE
   * provider). Absent (the default) leaves the host character's voice untouched.
   */
  voice?: { app: NetworkAppId };
}

export function createNetworkEdgePlugin(
  options: NetworkEdgePluginOptions,
): Plugin {
  const actionsEnabled = options.actionsEnabled ?? true;
  const routing = options.routing ?? "planner";
  return {
    name: "network-edge",
    description:
      "The Network: member context, availability state and post-turn signals.",
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
              now: options.now,
            }),
          ],
        }
      : {}),
    providers: [
      ...(options.voice ? [createNetworkVoiceProvider(options.voice)] : []),
      createMemberContextProvider({
        store: options.store,
        authority: options.authority,
      }),
    ],
    // In structured mode the field evaluator is the only path to a state change: a planner
    // SET_STATE there would bypass its authz (audit plugin-prototypes-1).
    // GET_UPDATES only reads (and marks seen), so it is offered in both routing modes.
    actions: actionsEnabled
      ? [
          ...(routing === "planner"
            ? [
                createSetStateAction({
                  store: options.store,
                  authority: options.authority,
                  now: options.now,
                }),
              ]
            : []),
          ...(options.store.readUpdates
            ? [
                createGetUpdatesAction({
                  store: options.store as GetUpdatesStore,
                  authority: options.authority,
                }),
              ]
            : []),
          // RELAY only sends the member's own message to the service, which classifies it and
          // sends its own wording; offered in both routing modes when the store can relay.
          ...(options.store.relay
            ? [
                createRelayAction({
                  store: options.store as RelayStore,
                  authority: options.authority,
                }),
              ]
            : []),
        ]
      : [],
    evaluators: [
      createNetworkSignalsEvaluator({
        store: options.store,
        authority: options.authority,
      }),
    ],
  };
}
