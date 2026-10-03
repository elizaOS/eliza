/**
 * Archives a complete current snapshot of one agent's legacy relationship rows.
 * The explicit maintenance operation reads source tables under a serializable
 * transaction and verifies full payload hashes after writing the snapshot.
 * PostgreSQL serializes each complete row; payload text stays opaque so native
 * numeric and timestamp precision survives driver conversion.
 * It never writes canonical graph tables or changes source authority. A later
 * successful run replaces this agent's snapshot; this is not immutable history.
 */
import { createHash } from "node:crypto";
import { ElizaError, stringToUuid } from "@elizaos/core";

export interface CoreRelationshipsInventorySession {
  execute(statement: string): Promise<Array<Record<string, unknown>>>;
}

export interface CoreRelationshipsInventoryDatabase {
  transaction<T>(
    callback: (session: CoreRelationshipsInventorySession) => Promise<T>,
    options: { isolationLevel: "serializable" },
  ): Promise<T>;
}

type CoreRelationshipsSqlExecutor =
  CoreRelationshipsInventorySession["execute"];

export type CoreRelationshipsSourceKind =
  | "entity"
  | "contact_component"
  | "relationship"
  | "identity"
  | "merge_candidate";

export interface CoreRelationshipsInventoryReport {
  agentId: string;
  status: "archived";
  sourceDigest: string;
  inventory: Record<CoreRelationshipsSourceKind, number>;
  archivedRecords: number;
}

type SourceRecord = {
  kind: CoreRelationshipsSourceKind;
  id: string;
  payload: string;
  hash: string;
};

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function recordId(row: Record<string, unknown>, key = "id"): string {
  const id = text(row[key]);
  if (!id) throw new Error(`Core relationships source row is missing ${key}`);
  return id;
}

async function loadSource(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  relationshipsWorldId: string,
): Promise<SourceRecord[]> {
  const agent = quote(agentId);
  const contacts = await exec(
    `SELECT id::text, entity_id::text, row_to_json(source_row)::text AS source_json FROM components source_row WHERE agent_id::text = ${agent}
      AND type = 'contact_info'
      AND world_id::text = ${quote(relationshipsWorldId)}
      AND source_entity_id::text = ${agent}
      ORDER BY id`,
  );
  const relationships = await exec(
    `SELECT id::text, source_entity_id::text, target_entity_id::text, row_to_json(source_row)::text AS source_json FROM relationships source_row WHERE agent_id::text = ${agent} ORDER BY id`,
  );
  const identities = await exec(
    `SELECT id::text, entity_id::text, row_to_json(source_row)::text AS source_json FROM entity_identities source_row WHERE agent_id::text = ${agent} ORDER BY id`,
  );
  const merges = await exec(
    `SELECT id::text, entity_a::text, entity_b::text, row_to_json(source_row)::text AS source_json FROM entity_merge_candidates source_row WHERE agent_id::text = ${agent} ORDER BY id`,
  );
  const referenced = new Set<string>([agentId]);
  for (const row of contacts) referenced.add(text(row.entity_id));
  for (const row of relationships) {
    referenced.add(text(row.source_entity_id));
    referenced.add(text(row.target_entity_id));
  }
  for (const row of identities) referenced.add(text(row.entity_id));
  for (const row of merges) {
    referenced.add(text(row.entity_a));
    referenced.add(text(row.entity_b));
  }
  const entityIds = [...referenced].filter(Boolean).map(quote).join(", ");
  const entities = entityIds
    ? await exec(
        `SELECT id::text, row_to_json(source_row)::text AS source_json FROM entities source_row WHERE agent_id::text = ${agent} AND id::text IN (${entityIds}) ORDER BY id`,
      )
    : [];
  const groups: Array<
    [CoreRelationshipsSourceKind, Array<Record<string, unknown>>]
  > = [
    ["entity", entities],
    ["contact_component", contacts],
    ["relationship", relationships],
    ["identity", identities],
    ["merge_candidate", merges],
  ];
  return groups.flatMap(([kind, rows]) =>
    rows.map((row) => {
      const payload = row.source_json;
      if (typeof payload !== "string" || payload.length === 0) {
        throw new Error(
          `Core relationships source row lacks PostgreSQL JSON: ${kind}:${recordId(row)}`,
        );
      }
      return { kind, id: recordId(row), payload, hash: hash(payload) };
    }),
  );
}

async function archive(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  record: SourceRecord,
  now: string,
): Promise<void> {
  const written =
    await exec(`INSERT INTO app_lifeops.core_relationships_source_records
    (agent_id, source_kind, source_id, source_hash, payload_json, archived_at)
    VALUES (${quote(agentId)}, ${quote(record.kind)}, ${quote(record.id)}, ${quote(record.hash)},
      ${quote(record.payload)}, ${quote(now)})
    RETURNING *`);
  const row = written[0];
  if (
    written.length !== 1 ||
    text(row?.agent_id) !== agentId ||
    text(row?.source_kind) !== record.kind ||
    text(row?.source_id) !== record.id ||
    text(row?.source_hash) !== record.hash ||
    text(row?.payload_json) !== record.payload ||
    text(row?.archived_at) !== now
  ) {
    throw new Error(
      `Core relationships archive write mismatch for ${record.kind}:${record.id}`,
    );
  }
}

/** Replace this agent's archived source snapshot without mutating either graph. */
export async function archiveCoreRelationshipsInventory(
  database: CoreRelationshipsInventoryDatabase,
  options: { agentId: string; now?: string },
): Promise<CoreRelationshipsInventoryReport> {
  const agentId = options.agentId.trim();
  if (!agentId) {
    throw new ElizaError("Supply an agentId for the relationship inventory", {
      code: "RELATIONSHIP_INVENTORY_AGENT_REQUIRED",
    });
  }
  const now = options.now ?? new Date().toISOString();
  const relationshipsWorldId = stringToUuid(`relationships-world-${agentId}`);
  try {
    return await database.transaction(
      async (session) => {
        const exec = session.execute.bind(session);
        await exec(`LOCK TABLE entities, components, relationships, entity_identities,
        entity_merge_candidates IN SHARE ROW EXCLUSIVE MODE`);
        const source = await loadSource(exec, agentId, relationshipsWorldId);
        await exec("CREATE SCHEMA IF NOT EXISTS app_lifeops");
        await exec(`CREATE TABLE IF NOT EXISTS app_lifeops.core_relationships_source_records (
        agent_id text NOT NULL, source_kind text NOT NULL, source_id text NOT NULL,
        source_hash text NOT NULL, payload_json text NOT NULL, archived_at text NOT NULL,
        PRIMARY KEY (agent_id, source_kind, source_id)
      )`);
        await exec(`DELETE FROM app_lifeops.core_relationships_source_records
        WHERE agent_id = ${quote(agentId)}`);
        const inventory: Record<CoreRelationshipsSourceKind, number> = {
          entity: 0,
          contact_component: 0,
          relationship: 0,
          identity: 0,
          merge_candidate: 0,
        };
        for (const record of source) {
          inventory[record.kind] += 1;
          await archive(exec, agentId, record, now);
        }
        const archived =
          await exec(`SELECT * FROM app_lifeops.core_relationships_source_records
        WHERE agent_id = ${quote(agentId)}`);
        const copies = new Map(
          archived.map((row) => [
            `${text(row.source_kind)}:${text(row.source_id)}`,
            row,
          ]),
        );
        if (archived.length !== source.length)
          throw new Error("Archive row count mismatch");
        for (const record of source) {
          const copy = copies.get(`${record.kind}:${record.id}`);
          if (
            !copy ||
            copy.source_hash !== record.hash ||
            hash(text(copy.payload_json)) !== record.hash
          ) {
            throw new Error(
              `Archive payload readback failed for ${record.kind}:${record.id}`,
            );
          }
        }
        return {
          agentId,
          status: "archived",
          inventory,
          archivedRecords: source.length,
          sourceDigest: hash(
            source
              .map((record) => `${record.kind}:${record.id}:${record.hash}`)
              .join("\n"),
          ),
        };
      },
      { isolationLevel: "serializable" },
    );
  } catch (cause) {
    // error-policy:J2 Preserve the database or payload failure after transaction rollback.
    throw new ElizaError(
      "Relationship inventory failed; inspect the source schema and archive write/readback before retrying",
      {
        code: "RELATIONSHIP_INVENTORY_FAILED",
        cause,
        context: { agentId },
      },
    );
  }
}
