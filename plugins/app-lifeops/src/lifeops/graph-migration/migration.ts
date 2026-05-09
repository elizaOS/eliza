/**
 * One-shot migrator: legacy `app_lifeops.life_relationships` rows →
 * paired `(Entity, Relationship)` rows in the new graph stores.
 *
 * Behavior:
 *   - DRY-RUN by default. `--apply: true` actually writes.
 *   - Promotes `(primary_channel, primary_handle)` to `Entity.identities[0]`
 *     with `verified: true, confidence: 1.0, addedVia: "import"`.
 *   - Maps `relationship_type` via `relationship-type-mapping.json`;
 *     unknown values pass through verbatim.
 *   - Copies `notes` into `Relationship.metadata.notes`.
 *   - Copies `last_contacted_at` into `Relationship.state.lastInteractionAt`.
 *   - Copies `tags` to `Entity.tags`.
 *   - Rewrites `life_relationship_interactions.relationship_id` from
 *     "pointing at the legacy row" to "pointing at the new edge"; the
 *     prior column is preserved as `legacy_entity_id` (added if missing)
 *     for one release.
 *   - Produces a manual-review JSON of every entity created, every
 *     relationship inferred, every type-mapping decision, and every
 *     merge proposal.
 *
 * Rollback: a dump of the legacy row state is captured in the manual-
 * review JSON before any write. The `rollbackFromReport` helper restores
 * `life_relationship_interactions` FK column from the report.
 */

import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { EntityStore } from "../entities/store.js";
import type { EntityIdentity } from "../entities/types.js";
import { SELF_ENTITY_ID } from "../entities/types.js";
import { RelationshipStore } from "../relationships/store.js";
import {
  executeRawSql,
  parseJsonArray,
  parseJsonRecord,
  sqlInteger,
  sqlJson,
  sqlNumber,
  sqlQuote,
  sqlText,
  toNumber,
  toText,
} from "../sql.js";

export interface MigrationOptions {
  agentId: string;
  apply: boolean;
  /** Override path to the relationship-type-mapping.json file (test only). */
  mappingPath?: string;
}

export interface MigrationReport {
  startedAt: string;
  finishedAt: string;
  agentId: string;
  apply: boolean;
  legacyRowsRead: number;
  entitiesCreated: number;
  relationshipsCreated: number;
  interactionsRewritten: number;
  decisions: MigrationDecision[];
  unknownTypes: string[];
  legacySnapshot: LegacyRowSnapshot[];
  errors: Array<{ legacyId: string; reason: string }>;
}

export interface MigrationDecision {
  legacyRelationshipId: string;
  legacyName: string;
  legacyType: string;
  mappedType: string;
  newEntityId: string;
  newRelationshipId: string;
  identityPlatform: string;
  identityHandle: string;
}

export interface LegacyRowSnapshot {
  id: string;
  primary_channel: string;
  primary_handle: string;
  relationship_type: string;
  last_contacted_at: string | null;
  notes: string;
  tags: string[];
  email: string | null;
  phone: string | null;
  metadata: Record<string, unknown>;
  name: string;
}

interface TypeMappingFile {
  mappings: Record<string, string>;
}

const DEFAULT_MAPPING_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "relationship-type-mapping.json",
);

function loadMapping(mappingPath?: string): Record<string, string> {
  const targetPath = mappingPath ?? DEFAULT_MAPPING_PATH;
  const raw = readFileSync(targetPath, "utf8");
  const parsed = JSON.parse(raw) as TypeMappingFile;
  return parsed.mappings ?? {};
}

function mapRelationshipType(
  legacy: string,
  mapping: Record<string, string>,
): string {
  const trimmed = legacy.trim().toLowerCase();
  if (mapping[trimmed]) return mapping[trimmed];
  // Pass through verbatim for unknowns; W3-A reviews the long tail.
  return legacy;
}

async function readLegacyRows(
  runtime: IAgentRuntime,
  agentId: string,
): Promise<LegacyRowSnapshot[]> {
  const rows = await executeRawSql(
    runtime,
    `SELECT * FROM app_lifeops.life_relationships
      WHERE agent_id = ${sqlQuote(agentId)}
      ORDER BY created_at ASC`,
  );
  return rows.map((row) => ({
    id: toText(row.id),
    primary_channel: toText(row.primary_channel),
    primary_handle: toText(row.primary_handle),
    relationship_type: toText(row.relationship_type),
    last_contacted_at: row.last_contacted_at
      ? toText(row.last_contacted_at)
      : null,
    notes: toText(row.notes, ""),
    tags: parseJsonArray<string>(row.tags_json),
    email: row.email ? toText(row.email) : null,
    phone: row.phone ? toText(row.phone) : null,
    metadata: parseJsonRecord(row.metadata_json),
    name: toText(row.name),
  }));
}

async function ensureLegacyEntityIdColumn(
  runtime: IAgentRuntime,
): Promise<void> {
  await executeRawSql(
    runtime,
    `ALTER TABLE app_lifeops.life_relationship_interactions
       ADD COLUMN IF NOT EXISTS legacy_entity_id TEXT`,
  );
}

/**
 * Run the migration. Returns the report; report.apply tells the caller
 * whether anything was actually written.
 */
export async function runGraphMigration(
  runtime: IAgentRuntime,
  options: MigrationOptions,
): Promise<MigrationReport> {
  const startedAt = new Date().toISOString();
  const mapping = loadMapping(options.mappingPath);

  const legacyRows = await readLegacyRows(runtime, options.agentId);

  const decisions: MigrationDecision[] = [];
  const unknownTypes = new Set<string>();
  const errors: MigrationReport["errors"] = [];

  let entitiesCreated = 0;
  let relationshipsCreated = 0;
  let interactionsRewritten = 0;

  if (options.apply) {
    await ensureLegacyEntityIdColumn(runtime);
  }

  const entityStore = new EntityStore(runtime, options.agentId);
  const relationshipStore = new RelationshipStore(runtime, options.agentId);

  if (options.apply) {
    await entityStore.ensureSelf();
  }

  for (const row of legacyRows) {
    try {
      const mappedType = mapRelationshipType(row.relationship_type, mapping);
      if (!mapping[row.relationship_type.trim().toLowerCase()]) {
        unknownTypes.add(row.relationship_type);
      }

      const platform = row.primary_channel || "email";
      const handle = row.primary_handle || row.email || row.phone || "";
      if (!handle) {
        errors.push({
          legacyId: row.id,
          reason: "no primary handle, email, or phone — cannot anchor identity",
        });
        continue;
      }

      const newEntityId = `ent_${crypto.randomUUID()}`;
      const newRelationshipId = `rel_${crypto.randomUUID()}`;

      const identity: EntityIdentity = {
        platform,
        handle,
        verified: true,
        confidence: 1.0,
        addedAt: startedAt,
        addedVia: "import",
        evidence: [`legacy:${row.id}`],
      };

      const additionalIdentities: EntityIdentity[] = [];
      if (row.email && (platform !== "email" || handle !== row.email)) {
        additionalIdentities.push({
          platform: "email",
          handle: row.email,
          verified: true,
          confidence: 0.95,
          addedAt: startedAt,
          addedVia: "import",
          evidence: [`legacy:${row.id}`],
        });
      }
      if (
        row.phone &&
        platform !== "phone" &&
        platform !== "sms" &&
        handle !== row.phone
      ) {
        additionalIdentities.push({
          platform: "phone",
          handle: row.phone,
          verified: true,
          confidence: 0.95,
          addedAt: startedAt,
          addedVia: "import",
          evidence: [`legacy:${row.id}`],
        });
      }

      decisions.push({
        legacyRelationshipId: row.id,
        legacyName: row.name,
        legacyType: row.relationship_type,
        mappedType,
        newEntityId,
        newRelationshipId,
        identityPlatform: platform,
        identityHandle: handle,
      });

      if (!options.apply) continue;

      await entityStore.upsert({
        entityId: newEntityId,
        type: "person",
        preferredName: row.name,
        identities: [identity, ...additionalIdentities],
        tags: row.tags,
        visibility: "owner_agent_admin",
        state: {
          ...(row.last_contacted_at
            ? { lastInboundAt: row.last_contacted_at }
            : {}),
        },
      });
      entitiesCreated += 1;

      const metadata: Record<string, unknown> = {
        ...row.metadata,
      };
      if (row.notes && row.notes.length > 0) {
        metadata.notes = row.notes;
      }

      await relationshipStore.upsert({
        relationshipId: newRelationshipId,
        fromEntityId: SELF_ENTITY_ID,
        toEntityId: newEntityId,
        type: mappedType,
        metadata,
        state: {
          ...(row.last_contacted_at
            ? { lastInteractionAt: row.last_contacted_at }
            : {}),
        },
        evidence: [`legacy:${row.id}`],
        confidence: 1.0,
        source: "import",
      });
      relationshipsCreated += 1;

      // Rewrite interaction FKs.
      const result = await executeRawSql(
        runtime,
        `UPDATE app_lifeops.life_relationship_interactions
            SET legacy_entity_id = relationship_id,
                relationship_id = ${sqlQuote(newRelationshipId)}
          WHERE agent_id = ${sqlQuote(options.agentId)}
            AND relationship_id = ${sqlQuote(row.id)}
            AND (legacy_entity_id IS NULL OR legacy_entity_id = '')`,
      );
      // PGLite/PG do not return affected-row counts uniformly; we
      // re-query for a counted result. We use a follow-up SELECT.
      const counted = await executeRawSql(
        runtime,
        `SELECT COUNT(*)::int AS n FROM app_lifeops.life_relationship_interactions
          WHERE agent_id = ${sqlQuote(options.agentId)}
            AND relationship_id = ${sqlQuote(newRelationshipId)}`,
      );
      const n = counted[0]?.n;
      if (typeof n === "number") {
        interactionsRewritten += n;
      } else if (typeof n === "string" && Number.isFinite(Number(n))) {
        interactionsRewritten += Number(n);
      }
      // result is unused; the query is the actual write.
      void result;
    } catch (error) {
      errors.push({
        legacyId: row.id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const finishedAt = new Date().toISOString();
  return {
    startedAt,
    finishedAt,
    agentId: options.agentId,
    apply: options.apply,
    legacyRowsRead: legacyRows.length,
    entitiesCreated,
    relationshipsCreated,
    interactionsRewritten,
    decisions,
    unknownTypes: Array.from(unknownTypes).sort(),
    legacySnapshot: legacyRows,
    errors,
  };
}

/**
 * Rollback support. Given a previously-emitted report, restore the
 * `life_relationship_interactions.relationship_id` column from
 * `legacy_entity_id`. Call only when an `--apply` migration needs to be
 * unwound.
 */
export async function rollbackInteractionRewrite(
  runtime: IAgentRuntime,
  report: MigrationReport,
): Promise<void> {
  if (!report.apply) {
    throw new Error("rollback requested for a dry-run report");
  }
  for (const decision of report.decisions) {
    await executeRawSql(
      runtime,
      `UPDATE app_lifeops.life_relationship_interactions
          SET relationship_id = legacy_entity_id,
              legacy_entity_id = NULL
        WHERE agent_id = ${sqlQuote(report.agentId)}
          AND relationship_id = ${sqlQuote(decision.newRelationshipId)}`,
    );
    // Delete the new relationship + entity rows.
    await executeRawSql(
      runtime,
      `DELETE FROM app_lifeops.life_relationships_v2
        WHERE agent_id = ${sqlQuote(report.agentId)}
          AND relationship_id = ${sqlQuote(decision.newRelationshipId)}`,
    );
    await executeRawSql(
      runtime,
      `DELETE FROM app_lifeops.life_entity_identities
        WHERE agent_id = ${sqlQuote(report.agentId)}
          AND entity_id = ${sqlQuote(decision.newEntityId)}`,
    );
    await executeRawSql(
      runtime,
      `DELETE FROM app_lifeops.life_entities
        WHERE agent_id = ${sqlQuote(report.agentId)}
          AND entity_id = ${sqlQuote(decision.newEntityId)}`,
    );
  }
}

// Silence unused-symbol warnings for helpers used only by external CLI
// glue (sqlInteger / sqlJson / sqlNumber / sqlText / toNumber).
void sqlInteger;
void sqlJson;
void sqlNumber;
void sqlText;
void toNumber;
