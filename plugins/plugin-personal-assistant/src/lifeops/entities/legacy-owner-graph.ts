/**
 * Reviews and explicitly transfers contacts written by the former owner-scoped
 * HTTP routes into the current agent graph. The complete source snapshot binds
 * confirmation; a transaction preserves graph identities and rejects collisions.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  ElizaError,
  type IAgentRuntime,
  resolveOwnerEntityIdOrDefault,
} from "@elizaos/core";
import {
  executeRawSqlTx,
  sqlQuote,
  type TransactionalDb,
  withTransaction,
} from "../sql.js";

const TABLES = [
  ["life_entities", "entity_id", "entity_id <> 'self'"],
  ["life_entity_identities", "id", "entity_id <> 'self'"],
  ["life_entity_attributes", "id", "entity_id <> 'self'"],
  ["life_relationships_v2", "relationship_id", "TRUE"],
  ["life_relationship_audit_events", "id", "TRUE"],
] as const;

type GraphRows = Record<string, unknown>[];

function conflict(message: string): never {
  throw new ElizaError(message, { code: "LEGACY_OWNER_GRAPH_REVIEW_REQUIRED" });
}

async function snapshot(
  tx: TransactionalDb,
  sourcePartition: string,
  targetPartition: string,
) {
  const tables: { table: string; rows: GraphRows }[] = [];
  for (const [table, key, predicate] of TABLES) {
    const rows = await executeRawSqlTx(
      tx,
      `SELECT * FROM app_lifeops.${table} WHERE agent_id = ${sqlQuote(sourcePartition)} AND ${predicate} ORDER BY ${key}`,
    );
    tables.push({ table, rows });
  }
  const content = { sourcePartition, targetPartition, tables };
  return {
    ...content,
    reviewSha256: createHash("sha256")
      .update(JSON.stringify(content))
      .digest("hex"),
  };
}

/** No source partition is accepted from a request: only the configured owner is eligible. */
export async function reviewLegacyOwnerGraph(
  runtime: IAgentRuntime,
  confirmationSha256?: string,
) {
  const sourcePartition = resolveOwnerEntityIdOrDefault(runtime);
  const targetPartition = runtime.agentId;
  if (sourcePartition === targetPartition)
    conflict(
      "The owner already uses the agent partition; no transfer is needed.",
    );
  return withTransaction(runtime, async (tx) => {
    // A rare, explicit migration must also exclude writers that predate this API.
    // Table locks cover inserts as well as updates without relying on advisory locks.
    await executeRawSqlTx(
      tx,
      `LOCK TABLE ${TABLES.map(([table]) => `app_lifeops.${table}`).join(", ")} IN SHARE ROW EXCLUSIVE MODE`,
    );
    const review = await snapshot(tx, sourcePartition, targetPartition);
    if (confirmationSha256 === undefined) return { ...review, adopted: false };
    if (confirmationSha256 !== review.reviewSha256)
      conflict(
        "Legacy contacts changed. Review the complete graph again before adopting it.",
      );
    if (review.tables.every(({ rows }) => rows.length === 0)) {
      conflict("No legacy graph records remain to adopt.");
    }
    const collisions = await executeRawSqlTx(
      tx,
      `SELECT source.entity_id FROM app_lifeops.life_entities source JOIN app_lifeops.life_entities target ON source.entity_id = target.entity_id WHERE source.agent_id = ${sqlQuote(sourcePartition)} AND target.agent_id = ${sqlQuote(targetPartition)} AND source.entity_id <> 'self'`,
    );
    if (collisions.length)
      conflict(
        "An agent contact already has a legacy contact ID. Resolve the collision before adoption.",
      );
    const orphanEdges = await executeRawSqlTx(
      tx,
      `SELECT relationship_id FROM app_lifeops.life_relationships_v2 edge WHERE edge.agent_id = ${sqlQuote(sourcePartition)} AND (NOT EXISTS (SELECT 1 FROM app_lifeops.life_entities entity WHERE entity.entity_id = edge.from_entity_id AND (entity.agent_id = ${sqlQuote(targetPartition)} OR (entity.agent_id = ${sqlQuote(sourcePartition)} AND entity.entity_id <> 'self'))) OR NOT EXISTS (SELECT 1 FROM app_lifeops.life_entities entity WHERE entity.entity_id = edge.to_entity_id AND (entity.agent_id = ${sqlQuote(targetPartition)} OR (entity.agent_id = ${sqlQuote(sourcePartition)} AND entity.entity_id <> 'self'))))`,
    );
    if (orphanEdges.length)
      conflict(
        "A legacy relationship has no destination contact. Repair the graph before adoption.",
      );
    const duplicateEdges = await executeRawSqlTx(
      tx,
      `SELECT source.relationship_id FROM app_lifeops.life_relationships_v2 source JOIN app_lifeops.life_relationships_v2 target ON source.from_entity_id = target.from_entity_id AND source.to_entity_id = target.to_entity_id AND source.type = target.type WHERE source.agent_id = ${sqlQuote(sourcePartition)} AND target.agent_id = ${sqlQuote(targetPartition)} AND source.status = 'active' AND target.status = 'active'`,
    );
    if (duplicateEdges.length)
      conflict(
        "An active agent relationship duplicates a legacy relationship. Resolve it before adoption.",
      );
    for (const [table, , predicate] of TABLES) {
      await executeRawSqlTx(
        tx,
        `UPDATE app_lifeops.${table} SET agent_id = ${sqlQuote(targetPartition)} WHERE agent_id = ${sqlQuote(sourcePartition)} AND ${predicate}`,
      );
    }
    await executeRawSqlTx(
      tx,
      `INSERT INTO app_lifeops.life_audit_events (id, agent_id, event_type, owner_type, owner_id, inputs_json, decision_json, actor, created_at) VALUES (${sqlQuote(randomUUID())}, ${sqlQuote(targetPartition)}, 'legacy_owner_graph_adopted', 'entity_graph', ${sqlQuote(targetPartition)}, ${sqlQuote(JSON.stringify({ sourcePartition, reviewSha256: review.reviewSha256 }))}, ${sqlQuote(JSON.stringify({ tables: review.tables.map(({ table, rows }) => ({ table, rowCount: rows.length })) }))}, 'owner', ${sqlQuote(new Date().toISOString())})`,
    );
    return { ...review, adopted: true };
  });
}
