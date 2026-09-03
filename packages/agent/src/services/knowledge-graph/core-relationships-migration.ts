/**
 * Non-destructive migration and cutover control for the legacy Core
 * RelationshipsService stores.
 *
 * The caller must provide one PostgreSQL-compatible connection for the whole
 * operation. A serializable transaction locks the agent receipt, archives every
 * source row verbatim, projects contacts/identities/edges into the runtime graph,
 * and verifies each receipt before an optional cutover. Cutover installs database
 * triggers that reject later writes to the retired stores for that agent; source
 * rows are never deleted.
 */

import { createHash } from "node:crypto";

export type CoreRelationshipsSqlExecutor = (
  statement: string,
) => Promise<Array<Record<string, unknown>>>;

export type CoreRelationshipsSourceKind =
  | "entity"
  | "contact_component"
  | "relationship"
  | "identity"
  | "merge_candidate";

export interface CoreRelationshipsMigrationReport {
  agentId: string;
  status: "verified" | "cutover";
  sourceDigest: string;
  inventory: Record<CoreRelationshipsSourceKind, number>;
  archivedRecords: number;
  projectedRecords: number;
}

type SourceRecord = {
  kind: CoreRelationshipsSourceKind;
  id: string;
  row: Record<string, unknown>;
  payload: string;
  hash: string;
};

function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function json(value: unknown): string {
  return quote(JSON.stringify(value));
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
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

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  return {};
}

function strings(value: unknown): string[] {
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  }
  return [];
}

function iso(value: unknown, fallback: string): string {
  if (value instanceof Date) return value.toISOString();
  const candidate = text(value);
  const milliseconds = Date.parse(candidate);
  return Number.isFinite(milliseconds)
    ? new Date(milliseconds).toISOString()
    : fallback;
}

function mappedEntityId(sourceId: string, agentId: string): string {
  return sourceId === agentId ? "self" : sourceId;
}

async function ensureControlPlane(
  exec: CoreRelationshipsSqlExecutor,
): Promise<void> {
  await exec("CREATE SCHEMA IF NOT EXISTS app_lifeops");
  await exec(`CREATE TABLE IF NOT EXISTS app_lifeops.core_relationships_migration_state (
    agent_id text PRIMARY KEY, status text NOT NULL, source_digest text NOT NULL,
    inventory_json text NOT NULL, started_at text NOT NULL, verified_at text, cutover_at text,
    CHECK (status IN ('inventory', 'copying', 'verified', 'cutover'))
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS app_lifeops.core_relationships_source_records (
    agent_id text NOT NULL, source_kind text NOT NULL, source_id text NOT NULL,
    source_hash text NOT NULL, payload_json text NOT NULL, archived_at text NOT NULL,
    PRIMARY KEY (agent_id, source_kind, source_id)
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS app_lifeops.core_relationships_migration_records (
    agent_id text NOT NULL, source_kind text NOT NULL, source_id text NOT NULL,
    source_hash text NOT NULL, target_kind text NOT NULL, target_id text NOT NULL,
    verified_at text NOT NULL, PRIMARY KEY (agent_id, source_kind, source_id)
  )`);
  await exec(`CREATE TABLE IF NOT EXISTS app_lifeops.core_relationships_merge_lineage (
    agent_id text NOT NULL, candidate_id text NOT NULL, entity_a text NOT NULL,
    entity_b text NOT NULL, status text NOT NULL, payload_json text NOT NULL,
    source_hash text NOT NULL, migrated_at text NOT NULL,
    PRIMARY KEY (agent_id, candidate_id)
  )`);
}

async function loadSource(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
): Promise<SourceRecord[]> {
  const agent = quote(agentId);
  const contacts = await exec(
    `SELECT * FROM components WHERE agent_id::text = ${agent} AND type = 'contact_info' ORDER BY id`,
  );
  const relationships = await exec(
    `SELECT * FROM relationships WHERE agent_id::text = ${agent} ORDER BY id`,
  );
  const identities = await exec(
    `SELECT * FROM entity_identities WHERE agent_id::text = ${agent} ORDER BY id`,
  );
  const merges = await exec(
    `SELECT * FROM entity_merge_candidates WHERE agent_id::text = ${agent} ORDER BY id`,
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
        `SELECT * FROM entities WHERE agent_id::text = ${agent} AND id::text IN (${entityIds}) ORDER BY id`,
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
      const payload = canonicalJson(row);
      return { kind, id: recordId(row), row, payload, hash: hash(payload) };
    }),
  );
}

async function archive(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  record: SourceRecord,
  now: string,
): Promise<void> {
  await exec(`INSERT INTO app_lifeops.core_relationships_source_records
    (agent_id, source_kind, source_id, source_hash, payload_json, archived_at)
    VALUES (${quote(agentId)}, ${quote(record.kind)}, ${quote(record.id)}, ${quote(record.hash)},
      ${quote(record.payload)}, ${quote(now)})
    ON CONFLICT (agent_id, source_kind, source_id) DO UPDATE SET
      source_hash = EXCLUDED.source_hash, payload_json = EXCLUDED.payload_json,
      archived_at = EXCLUDED.archived_at`);
}

async function ensureEntity(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  sourceId: string,
  sourceRow: Record<string, unknown> | undefined,
  now: string,
): Promise<string> {
  const targetId = mappedEntityId(sourceId, agentId);
  const names = strings(sourceRow?.names);
  const metadata = object(sourceRow?.metadata);
  const preferredName =
    targetId === "self"
      ? (names[0] ?? "self")
      : (names[0] ?? text(metadata.displayName, `Migrated ${sourceId}`));
  const createdAt = iso(sourceRow?.created_at, now);
  await exec(`INSERT INTO app_lifeops.life_entities
    (entity_id, agent_id, type, preferred_name, full_name, tags_json, visibility,
     state_last_observed_at, state_last_inbound_at, state_last_outbound_at,
     state_last_interaction_platform, created_at, updated_at)
    VALUES (${quote(targetId)}, ${quote(agentId)}, 'person', ${quote(preferredName)}, NULL,
      ${json([])}, ${quote(targetId === "self" ? "owner_only" : "owner_agent_admin")},
      NULL, NULL, NULL, NULL, ${quote(createdAt)}, ${quote(now)})
    ON CONFLICT (agent_id, entity_id) DO NOTHING`);
  if (sourceRow) {
    await exec(`INSERT INTO app_lifeops.life_entity_attributes
      (id, agent_id, entity_id, key, value_json, confidence, evidence_json, updated_at)
      VALUES (${quote(`core-entity:${sourceId}`)}, ${quote(agentId)}, ${quote(targetId)},
        'legacy.core.entity', ${quote(canonicalJson(sourceRow))}, 1, ${json([])}, ${quote(now)})
      ON CONFLICT (agent_id, entity_id, key) DO UPDATE SET
        value_json = EXCLUDED.value_json, confidence = EXCLUDED.confidence,
        evidence_json = EXCLUDED.evidence_json, updated_at = EXCLUDED.updated_at`);
  }
  return targetId;
}

async function projectContact(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  record: SourceRecord,
  now: string,
): Promise<string> {
  const data = object(record.row.data);
  const sourceEntityId = text(record.row.entity_id);
  const entityId = mappedEntityId(sourceEntityId, agentId);
  await exec(`INSERT INTO app_lifeops.life_entity_attributes
    (id, agent_id, entity_id, key, value_json, confidence, evidence_json, updated_at)
    VALUES (${quote(`core-contact:${record.id}`)}, ${quote(agentId)}, ${quote(entityId)},
      'legacy.core.contact_info', ${quote(canonicalJson(data))}, 1, ${json([])}, ${quote(now)})
    ON CONFLICT (agent_id, entity_id, key) DO UPDATE SET
      value_json = EXCLUDED.value_json, confidence = EXCLUDED.confidence,
      evidence_json = EXCLUDED.evidence_json, updated_at = EXCLUDED.updated_at`);
  const interactions = Array.isArray(data.interactions)
    ? data.interactions
    : [];
  const lastInteractionAt = iso(data.lastInteractionAt, "");
  const goal = object(data.relationshipGoal);
  const cadence =
    typeof goal.targetCadenceDays === "number"
      ? goal.targetCadenceDays
      : typeof data.followupThresholdDays === "number"
        ? data.followupThresholdDays
        : null;
  const metadata = {
    legacySource: { kind: record.kind, id: record.id, hash: record.hash },
    contactInfo: data,
    ...(cadence === null ? {} : { cadenceDays: Math.trunc(cadence) }),
  };
  const edgeId = `core-contact:${record.id}`;
  const legacyStatus = text(data.relationshipStatus, "active");
  const retired = legacyStatus === "archived" || legacyStatus === "blocked";
  const written = await exec(`INSERT INTO app_lifeops.life_relationships_v2
    (relationship_id, agent_id, from_entity_id, to_entity_id, type, metadata_json,
     cadence_days, state_last_observed_at, state_last_interaction_at,
     state_interaction_count, state_sentiment_trend, evidence_json, confidence,
     source, status, retired_at, retired_reason, created_at, updated_at)
    VALUES (${quote(edgeId)}, ${quote(agentId)}, 'self', ${quote(entityId)}, 'contact',
      ${quote(canonicalJson(metadata))}, ${cadence === null ? "NULL" : Math.trunc(cadence)},
      NULL, ${lastInteractionAt ? quote(lastInteractionAt) : "NULL"}, ${interactions.length},
      NULL, ${quote(canonicalJson(interactions.map((item) => text(object(item).externalRef)).filter(Boolean)))},
      1, 'migration', ${quote(retired ? "retired" : "active")},
      ${retired ? quote(iso(data.lastModified, now)) : "NULL"},
      ${retired ? quote(`legacy:${legacyStatus}`) : "NULL"},
      ${quote(iso(record.row.created_at, now))}, ${quote(now)})
    ON CONFLICT (relationship_id) DO UPDATE SET
      metadata_json = EXCLUDED.metadata_json, cadence_days = EXCLUDED.cadence_days,
      state_last_interaction_at = EXCLUDED.state_last_interaction_at,
      state_interaction_count = EXCLUDED.state_interaction_count,
      evidence_json = EXCLUDED.evidence_json, status = EXCLUDED.status,
      retired_at = EXCLUDED.retired_at, retired_reason = EXCLUDED.retired_reason,
      updated_at = EXCLUDED.updated_at
    WHERE app_lifeops.life_relationships_v2.agent_id = EXCLUDED.agent_id
      AND app_lifeops.life_relationships_v2.metadata_json::jsonb #>> '{legacySource,id}' = ${quote(record.id)}
    RETURNING relationship_id`);
  if (written.length !== 1) {
    throw new Error(`Canonical relationship id collision for ${edgeId}`);
  }
  await appendMigrationAudit(exec, agentId, edgeId, record, now);
  return edgeId;
}

async function projectRelationship(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  record: SourceRecord,
  now: string,
): Promise<string> {
  const metadata = object(record.row.metadata);
  const tags = strings(record.row.tags);
  const type =
    typeof metadata.type === "string"
      ? metadata.type
      : tags.includes("identity_link")
        ? "identity_link"
        : "legacy_relationship";
  const targetMetadata = {
    legacySource: { kind: record.kind, id: record.id, hash: record.hash },
    tags,
    metadata,
  };
  const written = await exec(`INSERT INTO app_lifeops.life_relationships_v2
    (relationship_id, agent_id, from_entity_id, to_entity_id, type, metadata_json,
     cadence_days, state_last_observed_at, state_last_interaction_at,
     state_interaction_count, state_sentiment_trend, evidence_json, confidence,
     source, status, retired_at, retired_reason, created_at, updated_at)
    VALUES (${quote(record.id)}, ${quote(agentId)},
      ${quote(mappedEntityId(text(record.row.source_entity_id), agentId))},
      ${quote(mappedEntityId(text(record.row.target_entity_id), agentId))}, ${quote(type)},
      ${quote(canonicalJson(targetMetadata))}, NULL, NULL, NULL, 0, NULL, ${json([])}, 1,
      'migration', 'active', NULL, NULL, ${quote(iso(record.row.created_at, now))}, ${quote(now)})
    ON CONFLICT (relationship_id) DO UPDATE SET metadata_json = EXCLUDED.metadata_json,
      type = EXCLUDED.type, updated_at = EXCLUDED.updated_at
    WHERE app_lifeops.life_relationships_v2.agent_id = EXCLUDED.agent_id
      AND app_lifeops.life_relationships_v2.metadata_json::jsonb #>> '{legacySource,id}' = ${quote(record.id)}
    RETURNING relationship_id`);
  if (written.length !== 1) {
    throw new Error(`Canonical relationship id collision for ${record.id}`);
  }
  await appendMigrationAudit(exec, agentId, record.id, record, now);
  return record.id;
}

async function appendMigrationAudit(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  relationshipId: string,
  record: SourceRecord,
  now: string,
): Promise<void> {
  await exec(`INSERT INTO app_lifeops.life_relationship_audit_events
    (id, agent_id, relationship_id, kind, details_json, created_at)
    VALUES (${quote(`core-migration:${record.kind}:${record.id}`)}, ${quote(agentId)},
      ${quote(relationshipId)}, 'core_relationships_migrated',
      ${quote(canonicalJson({ sourceKind: record.kind, sourceId: record.id, sourceHash: record.hash }))},
      ${quote(now)})
    ON CONFLICT (id) DO UPDATE SET details_json = EXCLUDED.details_json,
      created_at = EXCLUDED.created_at`);
}

async function projectIdentity(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  record: SourceRecord,
  now: string,
): Promise<string> {
  const entityId = mappedEntityId(text(record.row.entity_id), agentId);
  const addedAt = iso(record.row.first_seen, now);
  const evidence = strings(record.row.evidence_message_ids);
  const written = await exec(`INSERT INTO app_lifeops.life_entity_identities
    (id, agent_id, entity_id, platform, handle, connector_account_id, display_name,
     verified, confidence, added_at, added_via, evidence_json)
    VALUES (${quote(`core-identity:${record.id}`)}, ${quote(agentId)}, ${quote(entityId)},
      ${quote(text(record.row.platform))}, ${quote(text(record.row.handle))}, 'default', NULL,
      ${record.row.verified === true ? "TRUE" : "FALSE"}, ${Number(record.row.confidence) || 0},
      ${quote(addedAt)}, 'import', ${json(evidence)})
    ON CONFLICT (agent_id, entity_id, platform, connector_account_id, handle) DO UPDATE SET
      verified = app_lifeops.life_entity_identities.verified OR EXCLUDED.verified,
      confidence = GREATEST(app_lifeops.life_entity_identities.confidence, EXCLUDED.confidence),
      evidence_json = (SELECT COALESCE(jsonb_agg(DISTINCT item), '[]'::jsonb)::text
        FROM jsonb_array_elements(
          app_lifeops.life_entity_identities.evidence_json::jsonb || EXCLUDED.evidence_json::jsonb
        ) AS item)
    RETURNING id`);
  const targetId = text(written[0]?.id);
  if (!targetId)
    throw new Error(`Canonical identity projection failed for ${record.id}`);
  return targetId;
}

async function installWriteFences(
  exec: CoreRelationshipsSqlExecutor,
): Promise<void> {
  await exec(`CREATE OR REPLACE FUNCTION app_lifeops.reject_cutover_core_relationships_write()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE affected_agent text;
    BEGIN
      affected_agent := COALESCE(to_jsonb(NEW)->>'agent_id', to_jsonb(OLD)->>'agent_id');
      IF EXISTS (SELECT 1 FROM app_lifeops.core_relationships_migration_state
        WHERE agent_id = affected_agent AND status = 'cutover') THEN
        IF TG_TABLE_NAME <> 'components' OR
          COALESCE(to_jsonb(NEW)->>'type', to_jsonb(OLD)->>'type') = 'contact_info' THEN
          RAISE EXCEPTION 'Core RelationshipsService persistence is cut over for agent %', affected_agent
            USING ERRCODE = '55000';
        END IF;
      END IF;
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END $$`);
  for (const table of [
    "components",
    "relationships",
    "entity_identities",
    "entity_merge_candidates",
  ]) {
    await exec(
      `DROP TRIGGER IF EXISTS core_relationships_cutover_fence ON ${table}`,
    );
    await exec(`CREATE TRIGGER core_relationships_cutover_fence
      BEFORE INSERT OR UPDATE OR DELETE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION app_lifeops.reject_cutover_core_relationships_write()`);
  }
}

/** Archive, project, verify, and optionally fence one agent's legacy graph. */
export async function migrateCoreRelationshipsToKnowledgeGraph(
  exec: CoreRelationshipsSqlExecutor,
  options: { agentId: string; activateCutover?: boolean; now?: string },
): Promise<CoreRelationshipsMigrationReport> {
  const agentId = options.agentId.trim();
  if (!agentId)
    throw new Error("Core relationships migration requires an agentId");
  const now = options.now ?? new Date().toISOString();
  await ensureControlPlane(exec);
  await exec("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await exec(`INSERT INTO app_lifeops.core_relationships_migration_state
      (agent_id, status, source_digest, inventory_json, started_at)
      VALUES (${quote(agentId)}, 'inventory', '', '{}', ${quote(now)})
      ON CONFLICT (agent_id) DO NOTHING`);
    await exec(`SELECT agent_id FROM app_lifeops.core_relationships_migration_state
      WHERE agent_id = ${quote(agentId)} FOR UPDATE`);
    const source = await loadSource(exec, agentId);
    const inventory: Record<CoreRelationshipsSourceKind, number> = {
      entity: 0,
      contact_component: 0,
      relationship: 0,
      identity: 0,
      merge_candidate: 0,
    };
    for (const record of source) inventory[record.kind] += 1;
    const sourceDigest = hash(
      source
        .map((record) => `${record.kind}:${record.id}:${record.hash}`)
        .join("\n"),
    );
    await exec(`UPDATE app_lifeops.core_relationships_migration_state SET
      status = 'copying', source_digest = ${quote(sourceDigest)},
      inventory_json = ${quote(canonicalJson(inventory))}, started_at = ${quote(now)},
      verified_at = NULL, cutover_at = NULL WHERE agent_id = ${quote(agentId)}`);

    const entities = new Map(
      source
        .filter((record) => record.kind === "entity")
        .map((record) => [record.id, record.row]),
    );
    const referencedIds = new Set<string>([agentId]);
    for (const record of source) {
      for (const key of [
        "entity_id",
        "source_entity_id",
        "target_entity_id",
        "entity_a",
        "entity_b",
      ]) {
        const value = text(record.row[key]);
        if (value) referencedIds.add(value);
      }
    }
    for (const sourceId of referencedIds) {
      await ensureEntity(exec, agentId, sourceId, entities.get(sourceId), now);
    }

    let projectedRecords = 0;
    for (const record of source) {
      await archive(exec, agentId, record, now);
      let targetKind = "archive";
      let targetId = record.id;
      if (record.kind === "entity") {
        targetKind = "entity";
        targetId = mappedEntityId(record.id, agentId);
      } else if (record.kind === "contact_component") {
        targetKind = "relationship";
        targetId = await projectContact(exec, agentId, record, now);
      } else if (record.kind === "relationship") {
        targetKind = "relationship";
        targetId = await projectRelationship(exec, agentId, record, now);
      } else if (record.kind === "identity") {
        targetKind = "identity";
        targetId = await projectIdentity(exec, agentId, record, now);
      } else {
        await exec(`INSERT INTO app_lifeops.core_relationships_merge_lineage
          (agent_id, candidate_id, entity_a, entity_b, status, payload_json, source_hash, migrated_at)
          VALUES (${quote(agentId)}, ${quote(record.id)}, ${quote(mappedEntityId(text(record.row.entity_a), agentId))},
            ${quote(mappedEntityId(text(record.row.entity_b), agentId))}, ${quote(text(record.row.status, "pending"))},
            ${quote(record.payload)}, ${quote(record.hash)}, ${quote(now)})
          ON CONFLICT (agent_id, candidate_id) DO UPDATE SET status = EXCLUDED.status,
            payload_json = EXCLUDED.payload_json, source_hash = EXCLUDED.source_hash,
            migrated_at = EXCLUDED.migrated_at`);
        targetKind = "merge_lineage";
      }
      await exec(`INSERT INTO app_lifeops.core_relationships_migration_records
        (agent_id, source_kind, source_id, source_hash, target_kind, target_id, verified_at)
        VALUES (${quote(agentId)}, ${quote(record.kind)}, ${quote(record.id)}, ${quote(record.hash)},
          ${quote(targetKind)}, ${quote(targetId)}, ${quote(now)})
        ON CONFLICT (agent_id, source_kind, source_id) DO UPDATE SET
          source_hash = EXCLUDED.source_hash, target_kind = EXCLUDED.target_kind,
          target_id = EXCLUDED.target_id, verified_at = EXCLUDED.verified_at`);
      projectedRecords += 1;
    }

    const receipts = await exec(`SELECT source_kind, source_id, source_hash
      FROM app_lifeops.core_relationships_migration_records
      WHERE agent_id = ${quote(agentId)}`);
    const receiptMap = new Map(
      receipts.map((row) => [
        `${text(row.source_kind)}:${text(row.source_id)}`,
        text(row.source_hash),
      ]),
    );
    for (const record of source) {
      if (receiptMap.get(`${record.kind}:${record.id}`) !== record.hash) {
        throw new Error(
          `Core relationships readback mismatch for ${record.kind}:${record.id}`,
        );
      }
    }
    const archived =
      await exec(`SELECT source_kind, source_id, source_hash, payload_json
      FROM app_lifeops.core_relationships_source_records
      WHERE agent_id = ${quote(agentId)}`);
    const archivedMap = new Map(
      archived.map((row) => [
        `${text(row.source_kind)}:${text(row.source_id)}`,
        {
          sourceHash: text(row.source_hash),
          payloadHash: hash(text(row.payload_json)),
        },
      ]),
    );
    for (const record of source) {
      const copy = archivedMap.get(`${record.kind}:${record.id}`);
      if (
        copy?.sourceHash !== record.hash ||
        copy.payloadHash !== record.hash
      ) {
        throw new Error(
          `Core relationships archive readback mismatch for ${record.kind}:${record.id}`,
        );
      }
    }
    const staleArchives = archived.filter(
      (row) =>
        !source.some(
          (record) =>
            record.kind === row.source_kind &&
            record.id === text(row.source_id),
        ),
    );
    if (staleArchives.length > 0) {
      throw new Error(
        "Core relationships source rows disappeared after archival; refusing cutover",
      );
    }
    const staleReceipts = receipts.filter(
      (row) =>
        !source.some(
          (record) =>
            record.kind === row.source_kind &&
            record.id === text(row.source_id),
        ),
    );
    if (staleReceipts.length > 0) {
      throw new Error(
        "Core relationships source rows disappeared after a prior inventory; refusing cutover",
      );
    }
    if (options.activateCutover) await installWriteFences(exec);
    const status = options.activateCutover ? "cutover" : "verified";
    await exec(`UPDATE app_lifeops.core_relationships_migration_state SET
      status = ${quote(status)}, verified_at = ${quote(now)},
      cutover_at = ${options.activateCutover ? quote(now) : "NULL"}
      WHERE agent_id = ${quote(agentId)}`);
    await exec("COMMIT");
    return {
      agentId,
      status,
      sourceDigest,
      inventory,
      archivedRecords: source.length,
      projectedRecords,
    };
  } catch (error) {
    try {
      await exec("ROLLBACK");
    } catch {
      // error-policy:J6 best-effort transaction teardown must not hide the migration failure.
    }
    throw error;
  }
}
