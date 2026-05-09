/**
 * RelationshipStore — typed-edge persistence + observation API.
 *
 * Backed by `app_lifeops.life_relationships_v2`; soft-delete via the
 * `status` column with audit rows in `life_relationship_audit_events`.
 *
 * `observe` is the canonical entry point for "ingest extraction-time
 * evidence into the graph" — it strengthens an existing matching edge
 * (adds evidence, bumps interactionCount, updates state.lastInteractionAt)
 * instead of duplicating; only creates a new edge if no matching
 * `(from, to, type)` exists.
 *
 * Frozen surface per docs/audit/wave1-interfaces.md §2.3.
 */

import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";
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
import type {
  Relationship,
  RelationshipFilter,
  RelationshipSentiment,
  RelationshipSource,
  RelationshipState,
  RelationshipStatus,
} from "./types.js";

function isoNow(): string {
  return new Date().toISOString();
}

function readCadenceDays(
  metadata: Record<string, unknown> | undefined,
): number | null {
  if (!metadata) return null;
  const raw = metadata.cadenceDays;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.trunc(raw);
  }
  return null;
}

function rowToRelationship(row: Record<string, unknown>): Relationship {
  const metadata = parseJsonRecord(row.metadata_json);
  const state: RelationshipState = {};
  if (row.state_last_observed_at) {
    state.lastObservedAt = toText(row.state_last_observed_at);
  }
  if (row.state_last_interaction_at) {
    state.lastInteractionAt = toText(row.state_last_interaction_at);
  }
  const interactionCount = toNumber(row.state_interaction_count, 0);
  if (interactionCount > 0) {
    state.interactionCount = interactionCount;
  }
  if (row.state_sentiment_trend) {
    state.sentimentTrend = toText(
      row.state_sentiment_trend,
    ) as RelationshipSentiment;
  }

  const status = toText(row.status, "active") as RelationshipStatus;
  const retiredAt = row.retired_at ? toText(row.retired_at) : undefined;
  const retiredReason = row.retired_reason
    ? toText(row.retired_reason)
    : undefined;

  return {
    relationshipId: toText(row.relationship_id),
    fromEntityId: toText(row.from_entity_id),
    toEntityId: toText(row.to_entity_id),
    type: toText(row.type),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    state,
    evidence: parseJsonArray<string>(row.evidence_json),
    confidence: toNumber(row.confidence, 0),
    source: toText(row.source) as RelationshipSource,
    status,
    ...(retiredAt ? { retiredAt } : {}),
    ...(retiredReason ? { retiredReason } : {}),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

export class RelationshipStore {
  constructor(
    private readonly runtime: IAgentRuntime,
    private readonly agentId: string,
  ) {}

  async upsert(
    input: Omit<
      Relationship,
      "relationshipId" | "createdAt" | "updatedAt" | "status"
    > & {
      relationshipId?: string;
      status?: RelationshipStatus;
    },
  ): Promise<Relationship> {
    const now = isoNow();
    const relationshipId = input.relationshipId ?? `rel_${crypto.randomUUID()}`;
    const existing = await this.get(relationshipId);
    const createdAt = existing?.createdAt ?? now;
    const cadenceDays = readCadenceDays(input.metadata);
    const status = input.status ?? existing?.status ?? "active";

    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_relationships_v2 (
         relationship_id, agent_id, from_entity_id, to_entity_id, type,
         metadata_json, cadence_days, state_last_observed_at,
         state_last_interaction_at, state_interaction_count,
         state_sentiment_trend, evidence_json, confidence, source,
         status, retired_at, retired_reason, created_at, updated_at
       ) VALUES (
         ${sqlQuote(relationshipId)},
         ${sqlQuote(this.agentId)},
         ${sqlQuote(input.fromEntityId)},
         ${sqlQuote(input.toEntityId)},
         ${sqlQuote(input.type)},
         ${sqlJson(input.metadata ?? {})},
         ${cadenceDays === null ? "NULL" : sqlInteger(cadenceDays)},
         ${sqlText(input.state.lastObservedAt ?? null)},
         ${sqlText(input.state.lastInteractionAt ?? null)},
         ${sqlInteger(input.state.interactionCount ?? 0)},
         ${sqlText(input.state.sentimentTrend ?? null)},
         ${sqlJson(input.evidence ?? [])},
         ${sqlNumber(input.confidence)},
         ${sqlQuote(input.source)},
         ${sqlQuote(status)},
         ${sqlText(null)},
         ${sqlText(null)},
         ${sqlQuote(createdAt)},
         ${sqlQuote(now)}
       )
       ON CONFLICT (relationship_id) DO UPDATE SET
         from_entity_id = EXCLUDED.from_entity_id,
         to_entity_id = EXCLUDED.to_entity_id,
         type = EXCLUDED.type,
         metadata_json = EXCLUDED.metadata_json,
         cadence_days = EXCLUDED.cadence_days,
         state_last_observed_at = EXCLUDED.state_last_observed_at,
         state_last_interaction_at = EXCLUDED.state_last_interaction_at,
         state_interaction_count = EXCLUDED.state_interaction_count,
         state_sentiment_trend = EXCLUDED.state_sentiment_trend,
         evidence_json = EXCLUDED.evidence_json,
         confidence = EXCLUDED.confidence,
         source = EXCLUDED.source,
         status = EXCLUDED.status,
         updated_at = EXCLUDED.updated_at`,
    );

    const fetched = await this.get(relationshipId);
    if (!fetched) {
      throw new Error(
        `[RelationshipStore] failed to read back upserted relationship ${relationshipId}`,
      );
    }
    return fetched;
  }

  async get(relationshipId: string): Promise<Relationship | null> {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_relationships_v2
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND relationship_id = ${sqlQuote(relationshipId)}
        LIMIT 1`,
    );
    const row = rows[0];
    return row ? rowToRelationship(row) : null;
  }

  async list(filter?: RelationshipFilter): Promise<Relationship[]> {
    const clauses = [`agent_id = ${sqlQuote(this.agentId)}`];
    if (!filter?.includeRetired) {
      clauses.push(`status = 'active'`);
    }
    if (filter?.fromEntityId) {
      clauses.push(`from_entity_id = ${sqlQuote(filter.fromEntityId)}`);
    }
    if (filter?.toEntityId) {
      clauses.push(`to_entity_id = ${sqlQuote(filter.toEntityId)}`);
    }
    if (filter?.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      const list = types.map((t) => sqlQuote(t)).join(", ");
      clauses.push(`type IN (${list})`);
    }

    const limitClause =
      typeof filter?.limit === "number" && Number.isFinite(filter.limit)
        ? `LIMIT ${sqlInteger(filter.limit)}`
        : "";

    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_relationships_v2
        WHERE ${clauses.join(" AND ")}
        ORDER BY updated_at DESC
        ${limitClause}`,
    );
    let results = rows.map(rowToRelationship);

    if (filter?.metadataMatch) {
      results = results.filter((rel) => {
        if (!rel.metadata) return false;
        return Object.entries(filter.metadataMatch ?? {}).every(
          ([key, value]) =>
            JSON.stringify(rel.metadata?.[key] ?? null) ===
            JSON.stringify(value ?? null),
        );
      });
    }

    if (filter?.cadenceOverdueAsOf) {
      const asOfMs = Date.parse(filter.cadenceOverdueAsOf);
      if (!Number.isFinite(asOfMs)) {
        return [];
      }
      results = results.filter((rel) => {
        const cadenceDays = readCadenceDays(rel.metadata);
        if (cadenceDays === null) return false;
        const lastIso = rel.state.lastInteractionAt;
        if (!lastIso) {
          // No prior interaction — overdue by definition.
          return true;
        }
        const lastMs = Date.parse(lastIso);
        if (!Number.isFinite(lastMs)) return false;
        const overdueAtMs = lastMs + cadenceDays * 24 * 60 * 60 * 1000;
        return overdueAtMs <= asOfMs;
      });
    }

    return results;
  }

  /**
   * Strengthen-or-create. If an active edge with the same
   * `(from, to, type)` exists, fold the new evidence in, bump
   * `interactionCount`, advance `state.lastInteractionAt`, and (per spec)
   * pick the higher confidence between old and new. If the matching edge
   * is RETIRED, log the new evidence on the retired record but DO NOT
   * flip its state — return the retired edge unchanged. If no edge
   * exists, create a fresh one.
   */
  async observe(obs: {
    fromEntityId: string;
    toEntityId: string;
    type: string;
    metadataPatch?: Record<string, unknown>;
    evidence: string[];
    confidence: number;
    occurredAt?: string;
    source?: RelationshipSource;
  }): Promise<Relationship> {
    const occurredAt = obs.occurredAt ?? isoNow();

    const matching = await this.list({
      fromEntityId: obs.fromEntityId,
      toEntityId: obs.toEntityId,
      type: obs.type,
      includeRetired: true,
    });

    // Prefer active edges for strengthening; if all matches are retired,
    // attach evidence to the most-recent retired one without reactivating.
    const active = matching.find((rel) => rel.status === "active");
    const retired = matching.find((rel) => rel.status === "retired");

    if (active) {
      const mergedEvidence = Array.from(
        new Set([...active.evidence, ...obs.evidence]),
      );
      const mergedMetadata = {
        ...(active.metadata ?? {}),
        ...(obs.metadataPatch ?? {}),
      };
      const updated = await this.upsert({
        ...active,
        metadata: mergedMetadata,
        evidence: mergedEvidence,
        confidence: Math.max(active.confidence, obs.confidence),
        state: {
          ...active.state,
          lastObservedAt: occurredAt,
          lastInteractionAt: occurredAt,
          interactionCount: (active.state.interactionCount ?? 0) + 1,
        },
        source: obs.source ?? active.source,
      });
      return updated;
    }

    if (retired) {
      // Log evidence-on-retired without flipping state. Returns the
      // retired record unchanged in shape; updated_at stays.
      await this.appendAudit(retired.relationshipId, "observe_on_retired", {
        evidence: obs.evidence,
        confidence: obs.confidence,
        occurredAt,
      });
      return retired;
    }

    return this.upsert({
      fromEntityId: obs.fromEntityId,
      toEntityId: obs.toEntityId,
      type: obs.type,
      ...(obs.metadataPatch
        ? { metadata: { ...obs.metadataPatch } }
        : { metadata: {} }),
      state: {
        lastObservedAt: occurredAt,
        lastInteractionAt: occurredAt,
        interactionCount: 1,
      },
      evidence: [...obs.evidence],
      confidence: obs.confidence,
      source: obs.source ?? "extraction",
    });
  }

  /**
   * Soft-delete with audit. The edge stays queryable via
   * `list({ includeRetired: true })` but is filtered out by default and
   * never strengthened by new evidence.
   */
  async retire(relationshipId: string, reason: string): Promise<void> {
    const existing = await this.get(relationshipId);
    if (!existing) {
      throw new Error(
        `[RelationshipStore.retire] relationship ${relationshipId} not found`,
      );
    }
    const now = isoNow();
    await executeRawSql(
      this.runtime,
      `UPDATE app_lifeops.life_relationships_v2
          SET status = 'retired',
              retired_at = ${sqlQuote(now)},
              retired_reason = ${sqlQuote(reason)},
              updated_at = ${sqlQuote(now)}
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND relationship_id = ${sqlQuote(relationshipId)}`,
    );
    await this.appendAudit(relationshipId, "retire", { reason });
  }

  async listAuditEvents(relationshipId: string): Promise<
    Array<{
      id: string;
      kind: string;
      details: Record<string, unknown>;
      createdAt: string;
    }>
  > {
    const rows = await executeRawSql(
      this.runtime,
      `SELECT * FROM app_lifeops.life_relationship_audit_events
        WHERE agent_id = ${sqlQuote(this.agentId)}
          AND relationship_id = ${sqlQuote(relationshipId)}
        ORDER BY created_at ASC`,
    );
    return rows.map((row) => ({
      id: toText(row.id),
      kind: toText(row.kind),
      details: parseJsonRecord(row.details_json),
      createdAt: toText(row.created_at),
    }));
  }

  private async appendAudit(
    relationshipId: string,
    kind: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await executeRawSql(
      this.runtime,
      `INSERT INTO app_lifeops.life_relationship_audit_events (
         id, agent_id, relationship_id, kind, details_json, created_at
       ) VALUES (
         ${sqlQuote(`raud_${crypto.randomUUID()}`)},
         ${sqlQuote(this.agentId)},
         ${sqlQuote(relationshipId)},
         ${sqlQuote(kind)},
         ${sqlJson(details)},
         ${sqlQuote(isoNow())}
       )`,
    );
  }
}
