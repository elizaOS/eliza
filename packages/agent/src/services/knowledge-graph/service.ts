/**
 * KnowledgeGraphService — the runtime-owned entity/relationship knowledge
 * graph, exposed as a registered runtime service.
 *
 * The graph is a runtime primitive: any plugin (LifeOps, relationships
 * viewer, …) consumes it via `runtime.getService(...)` rather than
 * constructing the DB-backed stores itself. The service is a thin factory
 * over the per-agent {@link EntityStore} / {@link RelationshipStore}; the
 * `agentId` is the multi-tenant partition key and defaults to
 * `runtime.agentId`.
 */

import { type IAgentRuntime, Service } from "@elizaos/core";
import { EntityStore } from "./entity-store.ts";
import { RelationshipStore } from "./relationship-store.ts";

export const KNOWLEDGE_GRAPH_SERVICE = "eliza_knowledge_graph";

export class KnowledgeGraphService extends Service {
  static override serviceType = KNOWLEDGE_GRAPH_SERVICE;

  override capabilityDescription =
    "Runtime knowledge graph: entity nodes, typed relationship edges, and identity-merge over app_lifeops tables";

  static async start(runtime: IAgentRuntime): Promise<KnowledgeGraphService> {
    return new KnowledgeGraphService(runtime);
  }

  async stop(): Promise<void> {}

  /**
   * Per-agent entity store. `agentId` partitions the graph; it defaults to
   * the runtime's agent id and may be overridden for admin/multi-tenant
   * access (e.g. an admin entity inspecting another agent's graph).
   */
  getEntityStore(agentId: string = this.runtime.agentId): EntityStore {
    return new EntityStore(this.runtime, agentId);
  }

  /** Per-agent typed-edge store. See {@link getEntityStore} for `agentId`. */
  getRelationshipStore(
    agentId: string = this.runtime.agentId,
  ): RelationshipStore {
    return new RelationshipStore(this.runtime, agentId);
  }
}

/**
 * Resolve the registered {@link KnowledgeGraphService}. Returns `null` when
 * the runtime has not registered it (e.g. the "eliza" plugin is absent).
 */
export function resolveKnowledgeGraphService(
  runtime: IAgentRuntime,
): KnowledgeGraphService | null {
  return runtime.getService<KnowledgeGraphService>(KNOWLEDGE_GRAPH_SERVICE);
}
