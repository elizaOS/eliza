/**
 * Non-destructive migration verification for legacy Core RelationshipsService
 * stores.
 *
 * The caller must provide one PostgreSQL-compatible connection for the whole
 * operation. A serializable transaction locks the agent receipt, archives every
 * source row verbatim, projects contacts/identities/edges into the runtime graph,
 * and verifies each receipt. It does not change caller authority, fence writers,
 * or delete source rows.
 */

import { createHash } from "node:crypto";
import { stringToUuid } from "@elizaos/core";

export interface CoreRelationshipsMigrationSession {
  execute(statement: string): Promise<Array<Record<string, unknown>>>;
}

export interface CoreRelationshipsMigrationDatabase {
  execute(statement: string): Promise<Array<Record<string, unknown>>>;
  transaction<T>(
    callback: (session: CoreRelationshipsMigrationSession) => Promise<T>,
    options: { isolationLevel: "serializable" },
  ): Promise<T>;
}

type CoreRelationshipsSqlExecutor =
  CoreRelationshipsMigrationSession["execute"];

export type CoreRelationshipsSourceKind =
  | "entity"
  | "contact_component"
  | "relationship"
  | "identity"
  | "merge_candidate";

export interface CoreRelationshipsMigrationReport {
  agentId: string;
  status: "verified";
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

async function assertNoOtherActiveEdge(
  exec: CoreRelationshipsSqlExecutor,
  values: {
    agentId: string;
    relationshipId: string;
    fromEntityId: string;
    toEntityId: string;
    type: string;
    status: string;
  },
): Promise<void> {
  if (values.status !== "active") return;
  const matches = await exec(`SELECT relationship_id
    FROM app_lifeops.life_relationships_v2
    WHERE agent_id = ${quote(values.agentId)}
      AND from_entity_id = ${quote(values.fromEntityId)}
      AND to_entity_id = ${quote(values.toEntityId)}
      AND type = ${quote(values.type)} AND status = 'active'
      AND relationship_id <> ${quote(values.relationshipId)}
    FOR UPDATE`);
  if (matches.length > 0) {
    throw new Error(
      `Canonical active-edge collision for ${values.fromEntityId}:${values.toEntityId}:${values.type}`,
    );
  }
}

function assertRelationshipReadback(
  row: Record<string, unknown> | undefined,
  expected: {
    relationshipId: string;
    agentId: string;
    fromEntityId: string;
    toEntityId: string;
    type: string;
    metadataJson: string;
    cadenceDays: number | null;
    lastObservedAt: string | null;
    lastInteractionAt: string | null;
    interactionCount: number;
    sentimentTrend: string | null;
    evidenceJson: string;
    confidence: number;
    source: string;
    status: string;
    retiredAt: string | null;
    retiredReason: string | null;
    createdAt: string;
    updatedAt: string;
  },
): void {
  const actual = {
    relationshipId: text(row?.relationship_id),
    agentId: text(row?.agent_id),
    fromEntityId: text(row?.from_entity_id),
    toEntityId: text(row?.to_entity_id),
    type: text(row?.type),
    metadataJson: text(row?.metadata_json),
    cadenceDays:
      row?.cadence_days === null || row?.cadence_days === undefined
        ? null
        : Number(row.cadence_days),
    lastObservedAt: row?.state_last_observed_at
      ? text(row.state_last_observed_at)
      : null,
    lastInteractionAt: row?.state_last_interaction_at
      ? text(row.state_last_interaction_at)
      : null,
    interactionCount: Number(row?.state_interaction_count),
    sentimentTrend: row?.state_sentiment_trend
      ? text(row.state_sentiment_trend)
      : null,
    evidenceJson: text(row?.evidence_json),
    confidence: Number(row?.confidence),
    source: text(row?.source),
    status: text(row?.status),
    retiredAt: row?.retired_at ? text(row.retired_at) : null,
    retiredReason: row?.retired_reason ? text(row.retired_reason) : null,
    createdAt: text(row?.created_at),
    updatedAt: text(row?.updated_at),
  };
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      `Canonical relationship readback mismatch for ${expected.relationshipId}`,
    );
  }
}

async function ensureControlPlane(
  exec: CoreRelationshipsSqlExecutor,
): Promise<void> {
  await exec("CREATE SCHEMA IF NOT EXISTS app_lifeops");
  await exec(`CREATE TABLE IF NOT EXISTS app_lifeops.core_relationships_migration_state (
    agent_id text PRIMARY KEY, status text NOT NULL, source_digest text NOT NULL,
    inventory_json text NOT NULL, relationships_world_id text NOT NULL,
    started_at text NOT NULL, verified_at text,
    CHECK (status IN ('inventory', 'copying', 'verified'))
  )`);
  await exec(`ALTER TABLE app_lifeops.core_relationships_migration_state
    ADD COLUMN IF NOT EXISTS relationships_world_id text NOT NULL DEFAULT ''`);
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
  relationshipsWorldId: string,
): Promise<SourceRecord[]> {
  const agent = quote(agentId);
  const contacts = await exec(
    `SELECT * FROM components WHERE agent_id::text = ${agent}
      AND type = 'contact_info'
      AND world_id::text = ${quote(relationshipsWorldId)}
      AND source_entity_id::text = ${agent}
      ORDER BY id`,
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
  const written =
    await exec(`INSERT INTO app_lifeops.core_relationships_source_records
    (agent_id, source_kind, source_id, source_hash, payload_json, archived_at)
    VALUES (${quote(agentId)}, ${quote(record.kind)}, ${quote(record.id)}, ${quote(record.hash)},
      ${quote(record.payload)}, ${quote(now)})
    ON CONFLICT (agent_id, source_kind, source_id) DO UPDATE SET
      source_hash = EXCLUDED.source_hash, payload_json = EXCLUDED.payload_json,
      archived_at = EXCLUDED.archived_at
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
  const visibility = targetId === "self" ? "owner_only" : "owner_agent_admin";
  const provenanceId = `core-entity-provenance:${sourceId}`;
  const existing = await exec(`SELECT * FROM app_lifeops.life_entities
    WHERE agent_id = ${quote(agentId)} AND entity_id = ${quote(targetId)} FOR UPDATE`);
  const existingProvenance = await exec(`SELECT *
    FROM app_lifeops.life_entity_attributes
    WHERE agent_id = ${quote(agentId)} AND entity_id = ${quote(targetId)}
      AND key = 'legacy.core.migration_entity'
    FOR UPDATE`);
  if (existing.length > 1 || existingProvenance.length > 1) {
    throw new Error(`Canonical entity collision for ${targetId}`);
  }
  if (existing.length === 0 && existingProvenance.length > 0) {
    throw new Error(`Canonical entity provenance is orphaned for ${targetId}`);
  }
  const priorEntity = existing[0];
  const priorProvenance = existingProvenance[0];
  const bootstrappedSelf =
    targetId === "self" &&
    priorEntity !== undefined &&
    priorProvenance === undefined &&
    text(priorEntity.agent_id) === agentId &&
    text(priorEntity.type) === "person" &&
    text(priorEntity.preferred_name) === "self" &&
    priorEntity.full_name === null &&
    canonicalJson(strings(priorEntity.tags_json)) === canonicalJson([]) &&
    text(priorEntity.visibility) === "owner_only" &&
    priorEntity.state_last_observed_at === null &&
    priorEntity.state_last_inbound_at === null &&
    priorEntity.state_last_outbound_at === null &&
    priorEntity.state_last_interaction_platform === null &&
    Boolean(text(priorEntity.created_at)) &&
    Boolean(text(priorEntity.updated_at));
  let preferredNameOwned = existing.length === 0;
  let lastMigratedPreferredName: string | null =
    existing.length === 0 ? preferredName : null;
  if (priorEntity && !bootstrappedSelf) {
    const provenanceData = object(priorProvenance?.value_json);
    const preferredField = object(object(provenanceData.fields).preferredName);
    if (
      !priorProvenance ||
      text(priorProvenance.id) !== provenanceId ||
      text(provenanceData.sourceEntityId) !== sourceId ||
      typeof preferredField.owned !== "boolean" ||
      (preferredField.lastMigratedValue !== null &&
        typeof preferredField.lastMigratedValue !== "string")
    ) {
      throw new Error(
        `Canonical entity ${targetId} exists without matching migration provenance`,
      );
    }
    preferredNameOwned = preferredField.owned;
    lastMigratedPreferredName =
      preferredField.lastMigratedValue === null
        ? null
        : text(preferredField.lastMigratedValue);
    if (
      preferredNameOwned &&
      text(priorEntity.preferred_name) !== lastMigratedPreferredName
    ) {
      preferredNameOwned = false;
    }
  }
  let entityWrite: Array<Record<string, unknown>>;
  if (existing.length === 0) {
    entityWrite = await exec(`INSERT INTO app_lifeops.life_entities
      (entity_id, agent_id, type, preferred_name, full_name, tags_json, visibility,
       state_last_observed_at, state_last_inbound_at, state_last_outbound_at,
       state_last_interaction_platform, created_at, updated_at)
      VALUES (${quote(targetId)}, ${quote(agentId)}, 'person', ${quote(preferredName)}, NULL,
        ${json([])}, ${quote(visibility)},
        NULL, NULL, NULL, NULL, ${quote(createdAt)}, ${quote(now)})
      ON CONFLICT (agent_id, entity_id) DO NOTHING
      RETURNING *`);
  } else if (preferredNameOwned) {
    entityWrite = await exec(`UPDATE app_lifeops.life_entities SET
      preferred_name = ${quote(preferredName)}, updated_at = ${quote(now)}
      WHERE agent_id = ${quote(agentId)} AND entity_id = ${quote(targetId)}
      RETURNING *`);
    lastMigratedPreferredName = preferredName;
  } else {
    entityWrite = existing;
  }
  const entity = entityWrite[0];
  const inserted = existing.length === 0;
  const preservedEntityFieldsMatch =
    inserted ||
    (text(entity?.type) === text(priorEntity?.type) &&
      entity?.full_name === priorEntity?.full_name &&
      text(entity?.tags_json) === text(priorEntity?.tags_json) &&
      text(entity?.visibility) === text(priorEntity?.visibility) &&
      entity?.state_last_observed_at === priorEntity?.state_last_observed_at &&
      entity?.state_last_inbound_at === priorEntity?.state_last_inbound_at &&
      entity?.state_last_outbound_at === priorEntity?.state_last_outbound_at &&
      entity?.state_last_interaction_platform ===
        priorEntity?.state_last_interaction_platform &&
      text(entity?.created_at) === text(priorEntity?.created_at));
  if (
    entityWrite.length !== 1 ||
    text(entity?.entity_id) !== targetId ||
    text(entity?.agent_id) !== agentId ||
    !preservedEntityFieldsMatch ||
    (inserted &&
      (text(entity?.type) !== "person" ||
        text(entity?.preferred_name) !== preferredName ||
        entity?.full_name !== null ||
        canonicalJson(strings(entity?.tags_json)) !== canonicalJson([]) ||
        text(entity?.visibility) !== visibility ||
        entity?.state_last_observed_at !== null ||
        entity?.state_last_inbound_at !== null ||
        entity?.state_last_outbound_at !== null ||
        entity?.state_last_interaction_platform !== null ||
        text(entity?.created_at) !== createdAt ||
        text(entity?.updated_at) !== now)) ||
    (!inserted &&
      preferredNameOwned &&
      (text(entity?.preferred_name) !== preferredName ||
        text(entity?.updated_at) !== now)) ||
    (!inserted &&
      !preferredNameOwned &&
      (text(entity?.preferred_name) !== text(priorEntity?.preferred_name) ||
        text(entity?.updated_at) !== text(priorEntity?.updated_at)))
  ) {
    throw new Error(`Canonical entity readback mismatch for ${targetId}`);
  }
  const provenanceValue = canonicalJson({
    sourceEntityId: sourceId,
    fields: {
      preferredName: {
        owned: preferredNameOwned,
        lastMigratedValue: lastMigratedPreferredName,
      },
    },
  });
  const provenanceWrite =
    await exec(`INSERT INTO app_lifeops.life_entity_attributes
    (id, agent_id, entity_id, key, value_json, confidence, evidence_json, updated_at)
    VALUES (${quote(provenanceId)}, ${quote(agentId)}, ${quote(targetId)},
      'legacy.core.migration_entity', ${quote(provenanceValue)}, 1, ${json([])}, ${quote(now)})
    ON CONFLICT (agent_id, entity_id, key) DO UPDATE SET
      value_json = EXCLUDED.value_json, confidence = EXCLUDED.confidence,
      evidence_json = EXCLUDED.evidence_json, updated_at = EXCLUDED.updated_at
    WHERE app_lifeops.life_entity_attributes.id = EXCLUDED.id
    RETURNING *`);
  const provenance = provenanceWrite[0];
  if (
    provenanceWrite.length !== 1 ||
    text(provenance?.id) !== provenanceId ||
    text(provenance?.agent_id) !== agentId ||
    text(provenance?.entity_id) !== targetId ||
    text(provenance?.key) !== "legacy.core.migration_entity" ||
    text(provenance?.value_json) !== provenanceValue ||
    Number(provenance?.confidence) !== 1 ||
    canonicalJson(strings(provenance?.evidence_json)) !== canonicalJson([]) ||
    text(provenance?.updated_at) !== now
  ) {
    throw new Error(`Canonical entity provenance mismatch for ${targetId}`);
  }
  if (sourceRow) {
    const attributeWrite =
      await exec(`INSERT INTO app_lifeops.life_entity_attributes
      (id, agent_id, entity_id, key, value_json, confidence, evidence_json, updated_at)
      VALUES (${quote(`core-entity:${sourceId}`)}, ${quote(agentId)}, ${quote(targetId)},
        'legacy.core.entity', ${quote(canonicalJson(sourceRow))}, 1, ${json([])}, ${quote(now)})
      ON CONFLICT (agent_id, entity_id, key) DO UPDATE SET
        value_json = EXCLUDED.value_json, confidence = EXCLUDED.confidence,
        evidence_json = EXCLUDED.evidence_json, updated_at = EXCLUDED.updated_at
      RETURNING id, agent_id, entity_id, key, value_json, confidence, evidence_json, updated_at`);
    const attribute = attributeWrite[0];
    if (
      attributeWrite.length !== 1 ||
      text(attribute?.id) !== `core-entity:${sourceId}` ||
      text(attribute?.agent_id) !== agentId ||
      text(attribute?.entity_id) !== targetId ||
      text(attribute?.key) !== "legacy.core.entity" ||
      text(attribute?.value_json) !== canonicalJson(sourceRow) ||
      Number(attribute?.confidence) !== 1 ||
      canonicalJson(strings(attribute?.evidence_json)) !== canonicalJson([]) ||
      text(attribute?.updated_at) !== now
    ) {
      throw new Error(
        `Canonical entity attribute readback mismatch for ${sourceId}`,
      );
    }
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
  const attributeWrite =
    await exec(`INSERT INTO app_lifeops.life_entity_attributes
    (id, agent_id, entity_id, key, value_json, confidence, evidence_json, updated_at)
    VALUES (${quote(`core-contact:${record.id}`)}, ${quote(agentId)}, ${quote(entityId)},
      'legacy.core.contact_info', ${quote(canonicalJson(data))}, 1, ${json([])}, ${quote(now)})
    ON CONFLICT (agent_id, entity_id, key) DO UPDATE SET
      value_json = EXCLUDED.value_json, confidence = EXCLUDED.confidence,
      evidence_json = EXCLUDED.evidence_json, updated_at = EXCLUDED.updated_at
    RETURNING id, agent_id, entity_id, key, value_json, confidence, evidence_json, updated_at`);
  const contactAttribute = attributeWrite[0];
  if (
    attributeWrite.length !== 1 ||
    text(contactAttribute?.id) !== `core-contact:${record.id}` ||
    text(contactAttribute?.agent_id) !== agentId ||
    text(contactAttribute?.entity_id) !== entityId ||
    text(contactAttribute?.key) !== "legacy.core.contact_info" ||
    text(contactAttribute?.value_json) !== canonicalJson(data) ||
    Number(contactAttribute?.confidence) !== 1 ||
    canonicalJson(strings(contactAttribute?.evidence_json)) !==
      canonicalJson([]) ||
    text(contactAttribute?.updated_at) !== now
  ) {
    throw new Error(
      `Canonical contact attribute readback mismatch for ${record.id}`,
    );
  }
  await projectEmbeddedHandles(exec, agentId, entityId, record, data, now);
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
  const status = retired ? "retired" : "active";
  const retiredAt = retired ? iso(data.lastModified, now) : null;
  const retiredReason = retired ? `legacy:${legacyStatus}` : null;
  const createdAt = iso(record.row.created_at, now);
  const evidenceJson = canonicalJson(
    interactions.map((item) => text(object(item).externalRef)).filter(Boolean),
  );
  await assertNoOtherActiveEdge(exec, {
    agentId,
    relationshipId: edgeId,
    fromEntityId: "self",
    toEntityId: entityId,
    type: "contact",
    status,
  });
  const written = await exec(`INSERT INTO app_lifeops.life_relationships_v2
    (relationship_id, agent_id, from_entity_id, to_entity_id, type, metadata_json,
     cadence_days, state_last_observed_at, state_last_interaction_at,
     state_interaction_count, state_sentiment_trend, evidence_json, confidence,
     source, status, retired_at, retired_reason, created_at, updated_at)
    VALUES (${quote(edgeId)}, ${quote(agentId)}, 'self', ${quote(entityId)}, 'contact',
      ${quote(canonicalJson(metadata))}, ${cadence === null ? "NULL" : Math.trunc(cadence)},
      NULL, ${lastInteractionAt ? quote(lastInteractionAt) : "NULL"}, ${interactions.length},
      NULL, ${quote(evidenceJson)}, 1, 'migration', ${quote(status)},
      ${retiredAt ? quote(retiredAt) : "NULL"},
      ${retiredReason ? quote(retiredReason) : "NULL"},
      ${quote(createdAt)}, ${quote(now)})
    ON CONFLICT (relationship_id) DO UPDATE SET
      metadata_json = EXCLUDED.metadata_json, cadence_days = EXCLUDED.cadence_days,
      state_last_interaction_at = EXCLUDED.state_last_interaction_at,
      state_interaction_count = EXCLUDED.state_interaction_count,
      evidence_json = EXCLUDED.evidence_json, status = EXCLUDED.status,
      retired_at = EXCLUDED.retired_at, retired_reason = EXCLUDED.retired_reason,
      updated_at = EXCLUDED.updated_at
    WHERE app_lifeops.life_relationships_v2.agent_id = EXCLUDED.agent_id
      AND app_lifeops.life_relationships_v2.metadata_json::jsonb #>> '{legacySource,id}' = ${quote(record.id)}
    RETURNING *`);
  if (written.length !== 1) {
    throw new Error(`Canonical relationship id collision for ${edgeId}`);
  }
  assertRelationshipReadback(written[0], {
    relationshipId: edgeId,
    agentId,
    fromEntityId: "self",
    toEntityId: entityId,
    type: "contact",
    metadataJson: canonicalJson(metadata),
    cadenceDays: cadence === null ? null : Math.trunc(cadence),
    lastObservedAt: null,
    lastInteractionAt: lastInteractionAt || null,
    interactionCount: interactions.length,
    sentimentTrend: null,
    evidenceJson,
    confidence: 1,
    source: "migration",
    status,
    retiredAt,
    retiredReason,
    createdAt,
    updatedAt: now,
  });
  await appendMigrationAudit(exec, agentId, edgeId, record, now);
  return edgeId;
}

async function projectEmbeddedHandles(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  entityId: string,
  record: SourceRecord,
  data: Record<string, unknown>,
  now: string,
): Promise<void> {
  const handles = Array.isArray(data.handles) ? data.handles : [];
  const projectedIds = new Set<string>();
  for (let index = 0; index < handles.length; index += 1) {
    const handle = object(handles[index]);
    const platform = text(handle.platform).trim();
    const identifier = text(handle.identifier).trim();
    if (!platform || !identifier) {
      throw new Error(
        `Core contact handle ${record.id}:${index} is incomplete`,
      );
    }
    const handleId = text(handle.id, String(index)).trim() || String(index);
    const connectorAccountId = text(
      handle.connectorAccountId ?? handle.accountId,
      "default",
    ).trim();
    const displayName = text(handle.displayLabel).trim();
    const addedAt = iso(handle.addedAt, iso(record.row.created_at, now));
    const evidence = [`core-contact-handle:${record.id}:${handleId}`];
    const targetId = `core-handle:${record.id}:${handleId}`;
    if (projectedIds.has(targetId)) {
      throw new Error(`Duplicate Core contact handle id ${targetId}`);
    }
    projectedIds.add(targetId);
    const byId = await exec(`SELECT *
      FROM app_lifeops.life_entity_identities
      WHERE id = ${quote(targetId)} FOR UPDATE`);
    if (byId.length > 1) {
      throw new Error(`Canonical contact handle id collision for ${targetId}`);
    }
    if (
      byId[0] &&
      (text(byId[0].agent_id) !== agentId ||
        text(byId[0].entity_id) !== entityId ||
        text(byId[0].platform) !== platform ||
        text(byId[0].connector_account_id) !==
          (connectorAccountId || "default") ||
        text(byId[0].handle) !== identifier ||
        !strings(byId[0].evidence_json).includes(evidence[0]))
    ) {
      throw new Error(`Canonical contact handle id collision for ${targetId}`);
    }
    const sameRoute = await exec(`SELECT id
      FROM app_lifeops.life_entity_identities
      WHERE agent_id = ${quote(agentId)} AND entity_id = ${quote(entityId)}
        AND platform = ${quote(platform)}
        AND connector_account_id = ${quote(connectorAccountId || "default")}
        AND handle = ${quote(identifier)}
      FOR UPDATE`);
    if (
      sameRoute.length > 1 ||
      (sameRoute[0] && text(sameRoute[0].id) !== targetId)
    ) {
      throw new Error(
        `Canonical contact handle collision for ${record.id}:${handleId}`,
      );
    }
    const written = byId[0]
      ? await exec(`UPDATE app_lifeops.life_entity_identities SET
          display_name = COALESCE(display_name, ${displayName ? quote(displayName) : "NULL"}),
          verified = verified OR FALSE, confidence = GREATEST(confidence, 1),
          evidence_json = (SELECT jsonb_agg(item ORDER BY item::text)::text
            FROM (SELECT DISTINCT item FROM jsonb_array_elements(
              evidence_json::jsonb || ${quote(canonicalJson(evidence))}::jsonb
            ) AS items(item)) merged)
          WHERE id = ${quote(targetId)} RETURNING *`)
      : await exec(`INSERT INTO app_lifeops.life_entity_identities
          (id, agent_id, entity_id, platform, handle, connector_account_id, display_name,
           verified, confidence, added_at, added_via, evidence_json)
          VALUES (${quote(targetId)}, ${quote(agentId)}, ${quote(entityId)},
            ${quote(platform)}, ${quote(identifier)}, ${quote(connectorAccountId || "default")},
            ${displayName ? quote(displayName) : "NULL"}, FALSE, 1, ${quote(addedAt)}, 'import',
            ${json(evidence)}) RETURNING *`);
    const row = written[0];
    const expectedDisplayName = byId[0]?.display_name ?? (displayName || null);
    const expectedVerified = byId[0]?.verified === true;
    const expectedConfidence = Math.max(Number(byId[0]?.confidence ?? 0), 1);
    const expectedAddedAt = byId[0] ? text(byId[0].added_at) : addedAt;
    const expectedAddedVia = byId[0] ? text(byId[0].added_via) : "import";
    const expectedEvidence = Array.from(
      new Set([...strings(byId[0]?.evidence_json), ...evidence]),
    ).sort();
    if (
      written.length !== 1 ||
      text(row?.id) !== targetId ||
      text(row?.agent_id) !== agentId ||
      text(row?.entity_id) !== entityId ||
      text(row?.platform) !== platform ||
      text(row?.handle) !== identifier ||
      text(row?.connector_account_id) !== (connectorAccountId || "default") ||
      row?.display_name !== expectedDisplayName ||
      row?.verified !== expectedVerified ||
      Number(row?.confidence) !== expectedConfidence ||
      text(row?.added_at) !== expectedAddedAt ||
      text(row?.added_via) !== expectedAddedVia ||
      canonicalJson(strings(row?.evidence_json).sort()) !==
        canonicalJson(expectedEvidence)
    ) {
      throw new Error(
        `Canonical contact handle readback mismatch for ${record.id}:${handleId}`,
      );
    }
  }
  const prefix = `core-handle:${record.id}:`;
  const prior = await exec(`SELECT id, evidence_json
    FROM app_lifeops.life_entity_identities
    WHERE agent_id = ${quote(agentId)}
      AND left(id, ${prefix.length}) = ${quote(prefix)}
    FOR UPDATE`);
  for (const row of prior) {
    const id = text(row.id);
    if (projectedIds.has(id)) continue;
    const marker = `core-contact-handle:${record.id}:${id.slice(prefix.length)}`;
    const priorEvidence = strings(row.evidence_json);
    if (!priorEvidence.includes(marker)) {
      if (priorEvidence.some((item) => item.startsWith("core-identity:"))) {
        continue;
      }
      throw new Error(`Refusing to delete unowned contact handle ${id}`);
    }
    const remainingEvidence = priorEvidence.filter((item) => item !== marker);
    if (remainingEvidence.length === 0) {
      const deleted = await exec(`DELETE FROM app_lifeops.life_entity_identities
        WHERE agent_id = ${quote(agentId)} AND id = ${quote(id)}
        RETURNING id`);
      if (deleted.length !== 1 || text(deleted[0]?.id) !== id) {
        throw new Error(`Contact handle reconciliation failed for ${id}`);
      }
    } else {
      const expected = remainingEvidence.sort();
      const updated = await exec(`UPDATE app_lifeops.life_entity_identities
        SET evidence_json = ${quote(canonicalJson(expected))}
        WHERE agent_id = ${quote(agentId)} AND id = ${quote(id)}
        RETURNING id, evidence_json`);
      if (
        updated.length !== 1 ||
        text(updated[0]?.id) !== id ||
        canonicalJson(strings(updated[0]?.evidence_json).sort()) !==
          canonicalJson(expected)
      ) {
        throw new Error(`Contact handle reconciliation failed for ${id}`);
      }
    }
  }
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
  const fromEntityId = mappedEntityId(
    text(record.row.source_entity_id),
    agentId,
  );
  const toEntityId = mappedEntityId(text(record.row.target_entity_id), agentId);
  const createdAt = iso(record.row.created_at, now);
  await assertNoOtherActiveEdge(exec, {
    agentId,
    relationshipId: record.id,
    fromEntityId,
    toEntityId,
    type,
    status: "active",
  });
  const written = await exec(`INSERT INTO app_lifeops.life_relationships_v2
    (relationship_id, agent_id, from_entity_id, to_entity_id, type, metadata_json,
     cadence_days, state_last_observed_at, state_last_interaction_at,
     state_interaction_count, state_sentiment_trend, evidence_json, confidence,
     source, status, retired_at, retired_reason, created_at, updated_at)
    VALUES (${quote(record.id)}, ${quote(agentId)},
      ${quote(fromEntityId)}, ${quote(toEntityId)}, ${quote(type)},
      ${quote(canonicalJson(targetMetadata))}, NULL, NULL, NULL, 0, NULL, ${json([])}, 1,
      'migration', 'active', NULL, NULL, ${quote(createdAt)}, ${quote(now)})
    ON CONFLICT (relationship_id) DO UPDATE SET metadata_json = EXCLUDED.metadata_json,
      type = EXCLUDED.type, updated_at = EXCLUDED.updated_at
    WHERE app_lifeops.life_relationships_v2.agent_id = EXCLUDED.agent_id
      AND app_lifeops.life_relationships_v2.metadata_json::jsonb #>> '{legacySource,id}' = ${quote(record.id)}
    RETURNING *`);
  if (written.length !== 1) {
    throw new Error(`Canonical relationship id collision for ${record.id}`);
  }
  assertRelationshipReadback(written[0], {
    relationshipId: record.id,
    agentId,
    fromEntityId,
    toEntityId,
    type,
    metadataJson: canonicalJson(targetMetadata),
    cadenceDays: null,
    lastObservedAt: null,
    lastInteractionAt: null,
    interactionCount: 0,
    sentimentTrend: null,
    evidenceJson: canonicalJson([]),
    confidence: 1,
    source: "migration",
    status: "active",
    retiredAt: null,
    retiredReason: null,
    createdAt,
    updatedAt: now,
  });
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
  const detailsJson = canonicalJson({
    sourceKind: record.kind,
    sourceId: record.id,
    sourceHash: record.hash,
  });
  const auditId = `core-migration:${record.kind}:${record.id}`;
  const written =
    await exec(`INSERT INTO app_lifeops.life_relationship_audit_events
    (id, agent_id, relationship_id, kind, details_json, created_at)
    VALUES (${quote(auditId)}, ${quote(agentId)},
      ${quote(relationshipId)}, 'core_relationships_migrated',
      ${quote(detailsJson)},
      ${quote(now)})
    ON CONFLICT (id) DO UPDATE SET details_json = EXCLUDED.details_json,
      created_at = EXCLUDED.created_at
    RETURNING *`);
  const row = written[0];
  if (
    written.length !== 1 ||
    text(row?.id) !== auditId ||
    text(row?.agent_id) !== agentId ||
    text(row?.relationship_id) !== relationshipId ||
    text(row?.kind) !== "core_relationships_migrated" ||
    text(row?.details_json) !== detailsJson ||
    text(row?.created_at) !== now
  ) {
    throw new Error(`Canonical audit readback mismatch for ${relationshipId}`);
  }
}

async function projectIdentity(
  exec: CoreRelationshipsSqlExecutor,
  agentId: string,
  record: SourceRecord,
  now: string,
): Promise<string> {
  const entityId = mappedEntityId(text(record.row.entity_id), agentId);
  const addedAt = iso(record.row.first_seen, now);
  const evidence = Array.from(
    new Set([
      ...strings(record.row.evidence_message_ids),
      `core-identity:${record.id}`,
    ]),
  ).sort();
  const deterministicTargetId = `core-identity:${record.id}`;
  const platform = text(record.row.platform);
  const handle = text(record.row.handle);
  const verified = record.row.verified === true;
  const confidence = Number(record.row.confidence) || 0;
  const matchingRoute = await exec(`SELECT *
    FROM app_lifeops.life_entity_identities
    WHERE agent_id = ${quote(agentId)} AND entity_id = ${quote(entityId)}
      AND platform = ${quote(platform)} AND connector_account_id = 'default'
      AND handle = ${quote(handle)}
    FOR UPDATE`);
  if (matchingRoute.length > 1) {
    throw new Error(`Canonical identity route is ambiguous for ${record.id}`);
  }
  const existing = matchingRoute[0];
  const targetId = existing ? text(existing.id) : deterministicTargetId;
  if (!existing) {
    const idCollision = await exec(`SELECT id
      FROM app_lifeops.life_entity_identities
      WHERE id = ${quote(deterministicTargetId)} FOR UPDATE`);
    if (idCollision.length > 0) {
      throw new Error(`Canonical identity id collision for ${record.id}`);
    }
  }
  const expectedEvidence = Array.from(
    new Set([...strings(existing?.evidence_json), ...evidence]),
  ).sort();
  const written = existing
    ? await exec(`UPDATE app_lifeops.life_entity_identities SET
        verified = verified OR ${verified ? "TRUE" : "FALSE"},
        confidence = GREATEST(confidence, ${confidence}),
        evidence_json = (SELECT jsonb_agg(item ORDER BY item::text)::text
          FROM (SELECT DISTINCT item FROM jsonb_array_elements(
            evidence_json::jsonb || ${quote(canonicalJson(evidence))}::jsonb
          ) AS items(item)) merged)
        WHERE id = ${quote(targetId)} RETURNING *`)
    : await exec(`INSERT INTO app_lifeops.life_entity_identities
        (id, agent_id, entity_id, platform, handle, connector_account_id, display_name,
         verified, confidence, added_at, added_via, evidence_json)
        VALUES (${quote(targetId)}, ${quote(agentId)}, ${quote(entityId)},
          ${quote(platform)}, ${quote(handle)}, 'default', NULL,
          ${verified ? "TRUE" : "FALSE"}, ${confidence},
          ${quote(addedAt)}, 'import', ${json(evidence)}) RETURNING *`);
  const row = written[0];
  if (
    written.length !== 1 ||
    text(row?.id) !== targetId ||
    text(row?.agent_id) !== agentId ||
    text(row?.entity_id) !== entityId ||
    text(row?.platform) !== platform ||
    text(row?.handle) !== handle ||
    text(row?.connector_account_id) !== "default" ||
    row?.display_name !== (existing?.display_name ?? null) ||
    row?.verified !== (existing?.verified === true || verified) ||
    Number(row?.confidence) !==
      Math.max(Number(existing?.confidence ?? 0), confidence) ||
    text(row?.added_at) !== (existing ? text(existing.added_at) : addedAt) ||
    text(row?.added_via) !== (existing ? text(existing.added_via) : "import") ||
    canonicalJson(strings(row?.evidence_json).sort()) !==
      canonicalJson(expectedEvidence)
  )
    throw new Error(`Canonical identity projection failed for ${record.id}`);
  return targetId;
}

/** Archive, project, and verify one agent's legacy graph without changing authority. */
export async function migrateCoreRelationshipsToKnowledgeGraph(
  database: CoreRelationshipsMigrationDatabase,
  options: {
    agentId: string;
    now?: string;
  },
): Promise<CoreRelationshipsMigrationReport> {
  const agentId = options.agentId.trim();
  if (!agentId)
    throw new Error("Core relationships migration requires an agentId");
  const now = options.now ?? new Date().toISOString();
  const relationshipsWorldId = stringToUuid(`relationships-world-${agentId}`);
  await ensureControlPlane(database.execute.bind(database));
  return database.transaction(
    async (session) => {
      const exec = session.execute.bind(session);
      await exec(`LOCK TABLE entities, components, relationships, entity_identities,
      entity_merge_candidates IN SHARE ROW EXCLUSIVE MODE`);
      await exec(`INSERT INTO app_lifeops.core_relationships_migration_state
      (agent_id, status, source_digest, inventory_json, relationships_world_id, started_at)
      VALUES (${quote(agentId)}, 'inventory', '', '{}', ${quote(relationshipsWorldId)}, ${quote(now)})
      ON CONFLICT (agent_id) DO NOTHING`);
      const stateRows =
        await exec(`SELECT * FROM app_lifeops.core_relationships_migration_state
      WHERE agent_id = ${quote(agentId)} FOR UPDATE`);
      if (stateRows.length !== 1) {
        throw new Error("Core relationships migration state is unreadable");
      }
      const source = await loadSource(exec, agentId, relationshipsWorldId);
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
      inventory_json = ${quote(canonicalJson(inventory))},
      relationships_world_id = ${quote(relationshipsWorldId)}, started_at = ${quote(now)},
      verified_at = NULL WHERE agent_id = ${quote(agentId)}`);

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
        await ensureEntity(
          exec,
          agentId,
          sourceId,
          entities.get(sourceId),
          now,
        );
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
          const lineage =
            await exec(`INSERT INTO app_lifeops.core_relationships_merge_lineage
          (agent_id, candidate_id, entity_a, entity_b, status, payload_json, source_hash, migrated_at)
          VALUES (${quote(agentId)}, ${quote(record.id)}, ${quote(mappedEntityId(text(record.row.entity_a), agentId))},
            ${quote(mappedEntityId(text(record.row.entity_b), agentId))}, ${quote(text(record.row.status, "pending"))},
            ${quote(record.payload)}, ${quote(record.hash)}, ${quote(now)})
          ON CONFLICT (agent_id, candidate_id) DO UPDATE SET status = EXCLUDED.status,
            payload_json = EXCLUDED.payload_json, source_hash = EXCLUDED.source_hash,
            migrated_at = EXCLUDED.migrated_at
          RETURNING *`);
          const lineageRow = lineage[0];
          if (
            lineage.length !== 1 ||
            text(lineageRow?.agent_id) !== agentId ||
            text(lineageRow?.candidate_id) !== record.id ||
            text(lineageRow?.entity_a) !==
              mappedEntityId(text(record.row.entity_a), agentId) ||
            text(lineageRow?.entity_b) !==
              mappedEntityId(text(record.row.entity_b), agentId) ||
            text(lineageRow?.status) !== text(record.row.status, "pending") ||
            text(lineageRow?.payload_json) !== record.payload ||
            text(lineageRow?.source_hash) !== record.hash ||
            text(lineageRow?.migrated_at) !== now
          ) {
            throw new Error(
              `Canonical merge-lineage readback mismatch for ${record.id}`,
            );
          }
          targetKind = "merge_lineage";
        }
        const receiptWrite =
          await exec(`INSERT INTO app_lifeops.core_relationships_migration_records
        (agent_id, source_kind, source_id, source_hash, target_kind, target_id, verified_at)
        VALUES (${quote(agentId)}, ${quote(record.kind)}, ${quote(record.id)}, ${quote(record.hash)},
          ${quote(targetKind)}, ${quote(targetId)}, ${quote(now)})
        ON CONFLICT (agent_id, source_kind, source_id) DO UPDATE SET
          source_hash = EXCLUDED.source_hash, target_kind = EXCLUDED.target_kind,
          target_id = EXCLUDED.target_id, verified_at = EXCLUDED.verified_at
        RETURNING *`);
        const receipt = receiptWrite[0];
        if (
          receiptWrite.length !== 1 ||
          text(receipt?.agent_id) !== agentId ||
          text(receipt?.source_kind) !== record.kind ||
          text(receipt?.source_id) !== record.id ||
          text(receipt?.source_hash) !== record.hash ||
          text(receipt?.target_kind) !== targetKind ||
          text(receipt?.target_id) !== targetId ||
          text(receipt?.verified_at) !== now
        ) {
          throw new Error(
            `Core relationships receipt write mismatch for ${record.kind}:${record.id}`,
          );
        }
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
          "Core relationships source rows disappeared after archival; refusing verification",
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
          "Core relationships source rows disappeared after a prior inventory; refusing verification",
        );
      }
      await exec(`UPDATE app_lifeops.core_relationships_migration_state SET
      status = 'verified', verified_at = ${quote(now)}
      WHERE agent_id = ${quote(agentId)}`);
      return {
        agentId,
        status: "verified",
        sourceDigest,
        inventory,
        archivedRecords: source.length,
        projectedRecords,
      };
    },
    { isolationLevel: "serializable" },
  );
}
