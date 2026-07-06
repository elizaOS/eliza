/**
 * Relationships plugin registration adds graph CRUD, planner context, schema,
 * and the dashboard viewer over the runtime knowledge graph service.
 */
import type { Plugin } from "@elizaos/core";

import { entityAction } from "./actions/entity.js";
import * as dbSchema from "./db/index.js";
import { entityGraphProvider } from "./providers/entity-graph.js";

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
      // Developer-gated: the graph renders empty in the MVP (#14479), so it is
      // hidden from a fresh user's launcher AND view manager until Developer Mode
      // is on — kept and reachable, not deleted. `developer` here keeps the
      // manager grid in step with the launcher's own developer-gating of this id
      // (launcher-curation LAUNCHER_DEVELOPER_ORDER), which previously diverged
      // because the declaration claimed `system`.
      viewKind: "developer",
      label: "Relationships",
      description:
        "Entity and relationship knowledge-graph viewer: people, organizations, identities, and the typed edges between them.",
      icon: "Users",
      path: "/relationships",
      modalities: ["gui", "xr", "tui"],
      bundlePath: "dist/views/bundle.js",
      // First-party instrumented view (data-agent-id controls): grant the
      // agent-surface capability so the view broker admits agent-driven
      // fills/clicks (#13452 manifest gate).
      surface: { capabilities: ["agent-surface"] },
      componentExport: "RelationshipsView",
      tags: ["relationships", "entities", "people", "contacts", "graph"],
      relatedActions: ["ENTITY"],
      visibleInManager: true,
      desktopTabEnabled: true,
    },
  ],
};

export default relationshipsPlugin;
