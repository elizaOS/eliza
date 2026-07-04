/**
 * `ENTITY_GRAPH` provider.
 *
 * Injects a compact projection of the owner's runtime knowledge graph
 * (recently-updated people/organizations and the `self` ego-network edges)
 * into the planner each turn, so the planner can reason about who is being
 * discussed without re-querying the graph from inside an action handler.
 *
 * Reads the runtime-owned graph via `@elizaos/agent`'s
 * {@link KnowledgeGraphService} (`getEntityStore` / `getRelationshipStore`).
 * It does NOT construct DB stores itself.
 *
 * Distinct from the runtime `rolodex` provider (which projects the legacy
 * `relationships` graph-snapshot service at position 7); this provider
 * projects the new knowledge-graph stores at position -4.
 */

import { resolveKnowledgeGraphService } from "@elizaos/agent";
import type {
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { logger } from "@elizaos/core";
import { SELF_ENTITY_ID } from "@elizaos/shared";

import { RELATIONSHIPS_CONTEXTS, RELATIONSHIPS_LOG_PREFIX } from "../types.js";

const MAX_ENTITIES = 8;
const MAX_EDGES = 8;

interface EntityProjection {
  entityId: string;
  type: string;
  preferredName: string;
  platforms: string[];
}

interface EdgeProjection {
  fromEntityId: string;
  toEntityId: string;
  type: string;
}

export const entityGraphProvider: Provider = {
  name: "ENTITY_GRAPH",
  description:
    "Projection of the owner's known entities and ego-network edges from the runtime knowledge graph, for planner context.",
  position: -4,
  contexts: [...RELATIONSHIPS_CONTEXTS],
  contextGate: { anyOf: [...RELATIONSHIPS_CONTEXTS] },
  get: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<ProviderResult> => {
    const service = resolveKnowledgeGraphService(runtime);
    if (!service) {
      return { text: "", data: { entities: [], relationships: [] } };
    }

    try {
      const entityStore = service.getEntityStore();
      const relationshipStore = service.getRelationshipStore();

      const [entities, edges] = await Promise.all([
        entityStore.list({ limit: MAX_ENTITIES }),
        relationshipStore.list({
          fromEntityId: SELF_ENTITY_ID,
          limit: MAX_EDGES,
        }),
      ]);

      const entityProjections: EntityProjection[] = entities
        .filter((entity) => entity.entityId !== SELF_ENTITY_ID)
        .map((entity) => ({
          entityId: entity.entityId,
          type: entity.type,
          preferredName: entity.preferredName,
          platforms: Array.from(
            new Set(entity.identities.map((identity) => identity.platform)),
          ),
        }));

      const edgeProjections: EdgeProjection[] = edges.map((edge) => ({
        fromEntityId: edge.fromEntityId,
        toEntityId: edge.toEntityId,
        type: edge.type,
      }));

      if (entityProjections.length === 0 && edgeProjections.length === 0) {
        return { text: "", data: { entities: [], relationships: [] } };
      }

      const nameById = new Map(
        entities.map((entity) => [entity.entityId, entity.preferredName]),
      );
      const lines: string[] = [];
      if (entityProjections.length > 0) {
        lines.push("Known entities:");
        for (const entity of entityProjections) {
          const platforms =
            entity.platforms.length > 0
              ? ` [${entity.platforms.join(", ")}]`
              : "";
          lines.push(`- ${entity.preferredName} (${entity.type})${platforms}`);
        }
      }
      if (edgeProjections.length > 0) {
        lines.push("Your relationships:");
        for (const edge of edgeProjections) {
          const toName = nameById.get(edge.toEntityId) ?? edge.toEntityId;
          lines.push(`- you -[${edge.type}]-> ${toName}`);
        }
      }

      return {
        text: lines.join("\n"),
        data: {
          entities: entityProjections,
          relationships: edgeProjections,
        },
      };
    } catch (error) {
      // error-policy:J4 explicit degrade — a knowledge-graph store failure
      // (DB read, projection) must not render the designed "empty graph"
      // shape: the degraded result carries an error marker so consumers can
      // tell a broken graph read from a legitimately empty graph, and
      // reportError surfaces the failure to RECENT_ERRORS / owner-escalation
      // instead of a log line nothing reads.
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `${RELATIONSHIPS_LOG_PREFIX} ENTITY_GRAPH projection failed:`,
        message,
      );
      runtime.reportError?.("ENTITY_GRAPH.provider", error);
      return {
        text: "Error retrieving entity graph",
        data: { entities: [], relationships: [], error: message },
        values: { entityGraphError: message },
      };
    }
  },
};

export default entityGraphProvider;
