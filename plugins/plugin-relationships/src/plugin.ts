/**
 * Relationships plugin registration adds graph CRUD, planner context, and the
 * schema over the runtime knowledge graph service. The app owns presentation.
 */
import type { Plugin } from "@elizaos/core";

import { entityAction } from "./actions/entity.js";
import * as dbSchema from "./db/index.js";
import { entityGraphProvider } from "./providers/entity-graph.js";

export const relationshipsPlugin: Plugin = {
  name: "relationships",
  description:
    "Relationships graph capabilities over the runtime knowledge graph. Provides the KNOWLEDGE_GRAPH action (create/read/list/log_interaction/set_relationship), the ENTITY_GRAPH planner-context provider, and a drizzle pgSchema('app_relationships'). The app-owned /apps/relationships surface is the canonical presentation. Identity claims and merges are deterministic authority operations, not agent actions. The graph stores are owned by @elizaos/agent's KnowledgeGraphService; contact orchestration stays in @elizaos/plugin-personal-assistant.",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [entityAction],
  providers: [entityGraphProvider],
  services: [],
  schema: dbSchema,
};

export default relationshipsPlugin;
