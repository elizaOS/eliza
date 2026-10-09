/** Host identity and context adapters for the assistant-owned CONTACT action. */
import {
  createContactActions,
  hasContextSignalSyncForKey,
} from "@elizaos/plugin-assistant";
import { resolveRelationshipsGraphService } from "../services/relationships-graph.ts";

export const { contactAction, registerEntitySearchCategory } =
  createContactActions({
    resolveGraph: resolveRelationshipsGraphService,
    hasContextSignal: (message, state) =>
      hasContextSignalSyncForKey(message, state, "search_entity"),
  });
