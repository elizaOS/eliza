/**
 * Observable-semantics coverage for RelationshipStore behaviors adjacent to
 * the base suite: which parallel active edge absorbs an observation, the
 * shallow-replace depth of observe metadata patches, the inclusive cadence-
 * overdue boundary, repeated retirement auditing, and the evidence-dedupe
 * difference between the create and strengthen paths. Drives the real store
 * against an in-memory interpreter of the SQL shapes it emits; drizzle
 * `sql.raw` stays real. No production helper is replaced with a mock of itself.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  RelationshipSource,
  RelationshipState,
  RelationshipStatus,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelationshipStore } from "../relationship-store.ts";

interface GraphTables {
  relationships: Map<string, Record<string, unknown>>;
  audits: Array<Record<string, unknown>>;
}

function extractSql(query: unknown): string {
  if (typeof query === "string") return query;
  if (!query || typeof query !== "object") return "";
  const rec = query as { queryChunks?: unknown; __sql?: string };
  if (typeof rec.__sql === "string") return rec.__sql;
  const chunks = rec.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (!chunk || typeof chunk !== "object" || !("value" in chunk)) {
        return "";
      }
      const value = (chunk as { value: unknown }).value;
      if (typeof value === "string") return value;
      if (Array.isArray(value)) {
        return value.map((part) => String(part)).join("");
      }
      return "";
    })
    .join("");
}

function splitSqlList(inner: string): string[] {
  const values: string[] = [];
  let buf = "";
  let inSingle = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          buf += "'";
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === ",") {
      values.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) values.push(buf.trim());
  return values;
}

function decodeSqlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "NULL") return null;
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
    return Number(trimmed);
  }
  return trimmed;
}

function splitAndClauses(whereSql: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let depth = 0;
  let inSingle = false;
  for (let i = 0; i < whereSql.length; i += 1) {
    const ch = whereSql[i];
    if (inSingle) {
      buf += ch;
      if (ch === "'") {
        if (whereSql[i + 1] === "'") {
          buf += "'";
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      buf += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (
      depth === 0 &&
      whereSql.slice(i, i + 5).toUpperCase() === " AND " &&
      (i === 0 || /\s/.test(whereSql[i] ?? " "))
    ) {
      parts.push(buf.trim());
      buf = "";
      i += 4;
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) parts.push(buf.trim());
  return parts;
}

function rowMatches(row: Record<string, unknown>, whereSql: string): boolean {
  for (const cond of splitAndClauses(whereSql)) {
    const inMatch = cond.match(/^(\w+)\s+IN\s*\(([\s\S]*)\)$/i);
    if (inMatch) {
      const values = splitSqlList(inMatch[2]).map(decodeSqlValue);
      if (!values.includes(row[inMatch[1]])) return false;
      continue;
    }
    const eq = cond.match(/^(\w+)\s*=\s*([\s\S]+)$/);
    if (!eq) return false;
    if (row[eq[1]] !== decodeSqlValue(eq[2])) return false;
  }
  return true;
}

function parseAssignments(setSql: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const assign of splitSqlList(setSql)) {
    const m = assign.match(/^(\w+)\s*=\s*([\s\S]+)$/);
    if (m) out[m[1]] = decodeSqlValue(m[2]);
  }
  return out;
}

const UPSERT_UPDATE_COLUMNS = [
  "from_entity_id",
  "to_entity_id",
  "type",
  "metadata_json",
  "cadence_days",
  "state_last_observed_at",
  "state_last_interaction_at",
  "state_interaction_count",
  "state_sentiment_trend",
  "evidence_json",
  "confidence",
  "source",
  "status",
  "updated_at",
] as const;

function executeSql(
  sqlText: string,
  tables: GraphTables,
): { rows: Array<Record<string, unknown>> } {
  const trimmed = sqlText.trim();

  const insertRel = trimmed.match(
    /^INSERT\s+INTO\s+app_lifeops\.life_relationships_v2\s*\(([\s\S]+?)\)\s*VALUES\s*\(([\s\S]+?)\)\s*(ON\s+CONFLICT[\s\S]*)?$/i,
  );
  if (insertRel) {
    const columns = insertRel[1].split(",").map((s) => s.trim());
    const values = splitSqlList(insertRel[2]);
    const incoming: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      incoming[col] = decodeSqlValue(values[idx] ?? "NULL");
    });
    const id = String(incoming.relationship_id);
    const existing = tables.relationships.get(id);
    if (existing && insertRel[3]) {
      const merged: Record<string, unknown> = { ...existing };
      for (const col of UPSERT_UPDATE_COLUMNS) {
        merged[col] = incoming[col];
      }
      tables.relationships.set(id, merged);
      return { rows: [] };
    }
    tables.relationships.set(id, incoming);
    return { rows: [] };
  }

  const insertAudit = trimmed.match(
    /^INSERT\s+INTO\s+app_lifeops\.life_relationship_audit_events\s*\(([\s\S]+?)\)\s*VALUES\s*\(([\s\S]+?)\)$/i,
  );
  if (insertAudit) {
    const columns = insertAudit[1].split(",").map((s) => s.trim());
    const values = splitSqlList(insertAudit[2]);
    const row: Record<string, unknown> = {};
    columns.forEach((col, idx) => {
      row[col] = decodeSqlValue(values[idx] ?? "NULL");
    });
    tables.audits.push(row);
    return { rows: [] };
  }

  const selectRel = trimmed.match(
    /^SELECT\s+\*\s+FROM\s+app_lifeops\.life_relationships_v2\s+WHERE\s+([\s\S]+?)(?:\s+ORDER\s+BY\s+updated_at\s+DESC)?(?:\s+LIMIT\s+(\d+))?\s*$/i,
  );
  if (selectRel) {
    let result = Array.from(tables.relationships.values()).filter((row) =>
      rowMatches(row, selectRel[1].trim()),
    );
    if (/\bORDER\s+BY\s+updated_at\s+DESC/i.test(trimmed)) {
      result = result.sort((a, b) =>
        String(b.updated_at).localeCompare(String(a.updated_at)),
      );
    }
    if (selectRel[2] !== undefined) {
      result = result.slice(0, Number(selectRel[2]));
    }
    return { rows: result };
  }

  const selectAudit = trimmed.match(
    /^SELECT\s+\*\s+FROM\s+app_lifeops\.life_relationship_audit_events\s+WHERE\s+([\s\S]+?)\s+ORDER\s+BY\s+created_at\s+ASC\s*$/i,
  );
  if (selectAudit) {
    const result = tables.audits
      .filter((row) => rowMatches(row, selectAudit[1].trim()))
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return { rows: result };
  }

  const updateRel = trimmed.match(
    /^UPDATE\s+app_lifeops\.life_relationships_v2\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i,
  );
  if (updateRel) {
    const assignments = parseAssignments(updateRel[1]);
    for (const row of tables.relationships.values()) {
      if (!rowMatches(row, updateRel[2].trim())) continue;
      Object.assign(row, assignments);
    }
    return { rows: [] };
  }

  throw new Error(`unsupported SQL in relationship-store test: ${trimmed}`);
}

function createTables(): GraphTables {
  return { relationships: new Map(), audits: [] };
}

function createRuntime(agentId: string, tables: GraphTables): IAgentRuntime {
  return {
    agentId,
    adapter: {
      db: {
        execute: async (query: unknown) =>
          executeSql(extractSql(query), tables),
      },
    },
  } as unknown as IAgentRuntime;
}

function edgeInput(
  overrides: {
    relationshipId?: string;
    status?: RelationshipStatus;
    fromEntityId?: string;
    toEntityId?: string;
    type?: string;
    metadata?: Record<string, unknown>;
    state?: RelationshipState;
    evidence?: string[];
    confidence?: number;
    source?: RelationshipSource;
  } = {},
) {
  return {
    fromEntityId: overrides.fromEntityId ?? "from-a",
    toEntityId: overrides.toEntityId ?? "to-b",
    type: overrides.type ?? "knows",
    ...(overrides.metadata ? { metadata: overrides.metadata } : {}),
    state: overrides.state ?? {},
    evidence: overrides.evidence ?? [],
    confidence: overrides.confidence ?? 0.4,
    source: overrides.source ?? ("user_chat" as const),
    ...(overrides.relationshipId
      ? { relationshipId: overrides.relationshipId }
      : {}),
    ...(overrides.status ? { status: overrides.status } : {}),
  };
}

describe("RelationshipStore semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("strengthens only the most recently updated of two parallel active edges", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(edgeInput({ relationshipId: "rel_older" }));
    vi.setSystemTime(new Date("2026-06-01T12:00:01.000Z"));
    await store.upsert(
      edgeInput({
        relationshipId: "rel_newer",
        evidence: ["seed"],
        confidence: 0.25,
      }),
    );

    const olderBefore = await store.get("rel_older");
    if (!olderBefore) throw new Error("expected rel_older to exist");

    const observed = await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["obs"],
      confidence: 0.6,
      occurredAt: "2026-06-01T12:00:02.000Z",
    });

    expect(observed.relationshipId).toBe("rel_newer");
    expect(observed.evidence).toEqual(["seed", "obs"]);
    expect(observed.confidence).toBe(0.6);
    expect(observed.state.interactionCount).toBe(1);

    const olderAfter = await store.get("rel_older");
    expect(olderAfter).toEqual(olderBefore);
  });

  it("shallow-replaces nested metadata objects in an observe patch while keeping sibling keys", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_meta",
        metadata: {
          profile: { city: "sf", zip: "94110" },
          tier: "gold",
        },
      }),
    );

    const updated = await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["patch-evidence"],
      confidence: 0.5,
      metadataPatch: { profile: { city: "ny" } },
    });

    expect(updated.metadata).toEqual({
      profile: { city: "ny" },
      tier: "gold",
    });
  });

  it("treats the cadence-overdue boundary as inclusive using cadence supplied through an observe patch", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(edgeInput({ relationshipId: "rel_cad" }));

    await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["start"],
      confidence: 0.5,
      metadataPatch: { cadenceDays: 2 },
      occurredAt: "2026-06-01T09:00:00.000Z",
    });

    const exactlyDue = await store.list({
      cadenceOverdueAsOf: "2026-06-03T09:00:00.000Z",
    });
    expect(exactlyDue.map((rel) => rel.relationshipId)).toEqual(["rel_cad"]);

    const justBeforeDue = await store.list({
      cadenceOverdueAsOf: "2026-06-03T08:59:59.999Z",
    });
    expect(justBeforeDue).toEqual([]);
  });

  it("overwrites the retire reason on a second retirement and scopes audit events by agent", async () => {
    const tables = createTables();
    const storeA = new RelationshipStore(
      createRuntime("agent-a", tables),
      "agent-a",
    );
    const storeB = new RelationshipStore(
      createRuntime("agent-b", tables),
      "agent-b",
    );

    await storeA.upsert(edgeInput({ relationshipId: "rel_twice" }));
    vi.setSystemTime(new Date("2026-06-01T12:00:02.000Z"));
    await storeA.retire("rel_twice", "first reason");
    vi.setSystemTime(new Date("2026-06-01T12:00:05.000Z"));
    await storeA.retire("rel_twice", "second reason");

    const retired = await storeA.get("rel_twice");
    expect(retired?.status).toBe("retired");
    expect(retired?.retiredReason).toBe("second reason");
    expect(retired?.retiredAt).toBe("2026-06-01T12:00:05.000Z");
    expect(retired?.createdAt).toBe("2026-06-01T12:00:00.000Z");

    const events = await storeA.listAuditEvents("rel_twice");
    expect(events.map((event) => event.kind)).toEqual(["retire", "retire"]);
    expect(events.map((event) => event.details.reason)).toEqual([
      "first reason",
      "second reason",
    ]);

    await expect(storeB.listAuditEvents("rel_twice")).resolves.toEqual([]);
    await expect(storeB.get("rel_twice")).resolves.toBeNull();
  });

  it("stores repeated evidence verbatim on create but Set-dedupes it when strengthening", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );

    const created = await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["d1", "d1"],
      confidence: 0.5,
    });
    expect(created.evidence).toEqual(["d1", "d1"]);

    const strengthened = await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["d1", "d2", "d2"],
      confidence: 0.5,
      occurredAt: "2026-06-01T13:00:00.000Z",
    });
    expect(strengthened.evidence).toEqual(["d1", "d2"]);
  });
});
