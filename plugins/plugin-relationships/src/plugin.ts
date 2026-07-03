import type { Plugin } from "@elizaos/core";

import { entityAction } from "./actions/entity.js";
import * as dbSchema from "./db/index.js";
import { entityGraphProvider } from "./providers/entity-graph.js";

/**
 * `@elizaos/plugin-relationships`
 *
 * The relationships viewer + "extras" over the runtime knowledge graph. The
 * graph itself (`EntityStore` / `RelationshipStore`) is owned by the runtime:
 * `@elizaos/agent`'s `KnowledgeGraphService`. This plugin consumes it via
 * `resolveKnowledgeGraphService(runtime)` and adds:
 *   - the `KNOWLEDGE_GRAPH` graph-CRUD action,
 *   - the `ENTITY_GRAPH` planner-context provider,
 *   - the `/relationships` viewer.
 *
 * It does NOT register an `ENTITY` action — `@elizaos/plugin-personal-assistant`
 * owns that (rich Rolodex orchestration with an LLM planner). Keeping a
 * distinct action name avoids a duplicate `ENTITY` registration when both
 * plugins load together.
 *
 * Hard-depends on `@elizaos/plugin-sql` — the runtime registers migrations
 * from `schema` (this module's drizzle pgSchema('app_relationships')).
 */
export const relationshipsPlugin: Plugin = {
  name: "relationships",
  description:
    "Relationships viewer + extras over the runtime knowledge graph. Provides the KNOWLEDGE_GRAPH graph-CRUD action (create/read/list/log_interaction/set_identity/set_relationship/merge over the runtime EntityStore/RelationshipStore), the ENTITY_GRAPH planner-context provider, the /relationships viewer, and a drizzle pgSchema('app_relationships'). The graph stores are owned by @elizaos/agent's KnowledgeGraphService; contact orchestration stays in @elizaos/plugin-personal-assistant.",
  dependencies: ["@elizaos/plugin-sql"],
  actions: [entityAction],
  providers: [entityGraphProvider],
  services: [],
  schema: dbSchema,
  views: [
    {
      id: "relationships",
      viewKind: "system",
      label: "Relationships",
      description:
        "Entity and relationship knowledge-graph viewer: people, organizations, identities, and the typed edges between them.",
      icon: "Users",
      path: "/relationships",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      componentExport: "RelationshipsView",
      tags: ["relationships", "entities", "people", "contacts", "graph"],
      relatedActions: ["ENTITY"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default relationshipsPlugin;
