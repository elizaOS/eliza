/**
 * Persists the canonical graph in the agent adapter's durable record backend.
 * Stores hold one database transaction across each complete graph operation,
 * including identity decisions, edge rewrites and audit writes. No SQL is parsed.
 */
import {
  type DurableRecordStore,
  ElizaError,
  type IAgentRuntime,
} from "@elizaos/core";
import type {
  Entity,
  EntityFilter,
  Relationship,
  RelationshipFilter,
} from "@elizaos/shared/knowledge-graph";
import { normalizeEntityConnectorAccountId } from "@elizaos/shared/knowledge-graph";

const ENTITIES = "plugin_knowledge_graph_entities_v1";
const RELATIONSHIPS = "plugin_knowledge_graph_relationships_v1";
const AUDIT = "plugin_knowledge_graph_audit_v1";
const SCHEMA = "plugin_knowledge_graph_schema";

export interface GraphAuditRecord {
  id: string;
  relationshipId: string;
  kind: string;
  details: Record<string, unknown>;
  createdAt: string;
}

function failure(message: string): ElizaError {
  return new ElizaError(message, {
    code: "KNOWLEDGE_GRAPH_RECORD_STORE_INVALID",
  });
}

/** An explicit caller limit is pagination; omitted limits preserve the whole graph. */
function requestedPage<T>(rows: T[], limit: number | undefined): T[] {
  if (limit === undefined) return rows;
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw failure("Graph pagination requires a nonnegative integer limit");
  return rows.slice(0, limit);
}

export function graphRecordRepository(
  runtime: IAgentRuntime,
  agentId: string,
): GraphRecordRepository | null {
  const storage = runtime.adapter.recordStore;
  if (!storage) return null;
  if (
    storage.version !== 1 ||
    storage.agentId !== runtime.agentId ||
    agentId !== storage.agentId
  )
    throw failure(
      "Canonical graph records require this runtime's agent-bound version 1 database",
    );
  return new GraphRecordRepository(storage);
}

export class GraphRecordRepository {
  constructor(private readonly storage: DurableRecordStore) {}

  transaction<T>(operation: () => Promise<T>): Promise<T> {
    return this.storage.transaction(async () => {
      const version = await this.storage.get<number>(SCHEMA, "version");
      if (version !== null && version !== 1)
        throw failure(
          "Canonical graph record schema requires an explicit migration",
        );
      if (version === null) await this.storage.set(SCHEMA, "version", 1);
      return operation();
    });
  }

  getEntity(id: string): Promise<Entity | null> {
    return this.storage.get<Entity>(ENTITIES, id);
  }

  async putEntity(entity: Entity): Promise<Entity> {
    const identities = new Map<string, Entity["identities"][number]>();
    for (const identity of entity.identities) {
      const normalized = {
        ...identity,
        connectorAccountId: normalizeEntityConnectorAccountId(
          identity.connectorAccountId,
        ),
      };
      const key = JSON.stringify([
        normalized.platform,
        normalized.connectorAccountId,
        normalized.handle,
      ]);
      const previous = identities.get(key);
      identities.set(key, {
        ...normalized,
        addedAt: previous ? previous.addedAt : normalized.addedAt,
      });
    }
    const record = {
      ...entity,
      identities: [...identities.values()].sort((a, b) =>
        a.addedAt.localeCompare(b.addedAt),
      ),
    };
    await this.storage.set(ENTITIES, entity.entityId, record);
    return structuredClone(record);
  }

  async listEntities(filter?: EntityFilter): Promise<Entity[]> {
    const rows = (await this.storage.getAll<Entity>(ENTITIES)).filter(
      (entity) => {
        if (filter?.type && entity.type !== filter.type) return false;
        if (filter?.tag && !entity.tags.includes(filter.tag)) return false;
        if (filter?.nameContains) {
          const needle = filter.nameContains.toLowerCase();
          if (
            !entity.preferredName.toLowerCase().includes(needle) &&
            !entity.fullName?.toLowerCase().includes(needle)
          )
            return false;
        }
        if (filter?.hasPlatform || filter?.hasConnectorAccountId) {
          if (
            !entity.identities.some(
              (identity) =>
                (!filter.hasPlatform ||
                  identity.platform.toLowerCase() ===
                    filter.hasPlatform.toLowerCase()) &&
                (!filter.hasConnectorAccountId ||
                  normalizeEntityConnectorAccountId(
                    identity.connectorAccountId,
                  ) ===
                    normalizeEntityConnectorAccountId(
                      filter.hasConnectorAccountId,
                    )),
            )
          )
            return false;
        }
        return true;
      },
    );
    rows.sort((a, b) => a.preferredName.localeCompare(b.preferredName));
    return requestedPage(rows, filter?.limit);
  }

  async deleteEntity(id: string): Promise<void> {
    await this.storage.delete(ENTITIES, id);
  }

  getRelationship(id: string): Promise<Relationship | null> {
    return this.storage.get<Relationship>(RELATIONSHIPS, id);
  }

  async putRelationship(relationship: Relationship): Promise<Relationship> {
    await this.storage.set(
      RELATIONSHIPS,
      relationship.relationshipId,
      relationship,
    );
    return structuredClone(relationship);
  }

  async listRelationships(
    filter?: RelationshipFilter,
  ): Promise<Relationship[]> {
    const rows = (
      await this.storage.getAll<Relationship>(RELATIONSHIPS)
    ).filter((row) => {
      if (!filter?.includeRetired && row.status !== "active") return false;
      if (filter?.fromEntityId && row.fromEntityId !== filter.fromEntityId)
        return false;
      if (filter?.toEntityId && row.toEntityId !== filter.toEntityId)
        return false;
      if (filter?.type) {
        const types = Array.isArray(filter.type) ? filter.type : [filter.type];
        if (!types.includes(row.type)) return false;
      }
      return true;
    });
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return requestedPage(rows, filter?.limit);
  }

  async retargetRelationships(
    sourceId: string,
    targetId: string,
    now: string,
  ): Promise<void> {
    for (const row of await this.storage.getAll<Relationship>(RELATIONSHIPS)) {
      if (row.fromEntityId !== sourceId && row.toEntityId !== sourceId)
        continue;
      await this.putRelationship({
        ...row,
        fromEntityId:
          row.fromEntityId === sourceId ? targetId : row.fromEntityId,
        toEntityId: row.toEntityId === sourceId ? targetId : row.toEntityId,
        updatedAt: now,
      });
    }
  }

  appendAudit(row: GraphAuditRecord): Promise<void> {
    return this.storage.set(AUDIT, row.id, row);
  }

  async listAudit(
    id: string,
  ): Promise<Omit<GraphAuditRecord, "relationshipId">[]> {
    return (await this.storage.getAll<GraphAuditRecord>(AUDIT))
      .filter((row) => row.relationshipId === id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(({ relationshipId: _relationshipId, ...row }) => row);
  }
}
