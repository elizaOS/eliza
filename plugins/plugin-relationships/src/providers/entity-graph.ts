/**
 * `ENTITY_GRAPH` provider — STUB.
 *
 * Injects a compact projection of the owner's knowledge graph (recently
 * observed people, organizations, and the user's strongest edges) into the
 * planner each turn. Lets the planner reason about who is being discussed
 * without re-querying the graph from inside an action handler.
 *
 * TODO(decomposition): port the real implementation from the LifeOps
 * `lifeops` aggregator provider
 * (`plugins/plugin-personal-assistant/src/providers/lifeops.ts`) — specifically the
 * entity / relationship sections produced from `EntityStore.list()` +
 * `RelationshipStore.list({ fromEntityId: SELF_ENTITY_ID })`. Until that
 * port lands this provider returns an empty projection so it is safe to
 * register on the plugin.
 */

import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";

import { RELATIONSHIPS_CONTEXTS } from "../types.js";

export const entityGraphProvider: Provider = {
  name: "ENTITY_GRAPH",
  description:
    "Projection of the owner's known entities and ego-network edges for planner context. STUB — returns an empty projection until the lifeops port lands.",
  position: -4,
  contexts: [...RELATIONSHIPS_CONTEXTS],
  contextGate: { anyOf: [...RELATIONSHIPS_CONTEXTS] },
  get: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    // TODO(decomposition): replace with a real projection once
    // EntityStore + RelationshipStore are ported from plugin-lifeops.
    return {
      text: "",
      data: { entities: [], relationships: [] },
    };
  },
};

export default entityGraphProvider;
