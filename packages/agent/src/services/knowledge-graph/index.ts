/**
 * Runtime knowledge-graph: entity nodes + typed relationship edges.
 *
 * The DB-backed stores and their schema are owned by `@elizaos/agent` (the
 * runtime) and surfaced through the registered {@link KnowledgeGraphService}.
 * Pure KG types and the identity-merge engine live in `@elizaos/shared`.
 */

export { EntityStore } from "./entity-store.ts";
export { RelationshipStore } from "./relationship-store.ts";
export { knowledgeGraphSchema } from "./schema.ts";
export {
  KNOWLEDGE_GRAPH_SERVICE,
  KnowledgeGraphService,
  resolveKnowledgeGraphService,
} from "./service.ts";
