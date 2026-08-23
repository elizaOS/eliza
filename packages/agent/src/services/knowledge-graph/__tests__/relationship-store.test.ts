/**
 * Unit coverage for RelationshipStore persistence, list filters, observe
 * strengthen-or-create, and retire/audit. Drives the real store against an
 * in-memory interpreter of the SQL shapes it emits; drizzle `sql.raw` stays
 * real. No production helper is replaced with a mock of itself.
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

describe("RelationshipStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null for a missing relationship id", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await expect(store.get("rel_missing")).resolves.toBeNull();
  });

  it("creates an edge with a generated rel_ id and omits empty metadata", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    const created = await store.upsert(edgeInput());
    expect(created.relationshipId).toMatch(
      /^rel_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(created.status).toBe("active");
    expect(created.metadata).toBeUndefined();
    expect(created.state).toEqual({});
    expect(created.evidence).toEqual([]);
    expect(created.confidence).toBe(0.4);
    expect(created.createdAt).toBe("2026-06-01T12:00:00.000Z");
    expect(created.updatedAt).toBe("2026-06-01T12:00:00.000Z");
  });

  it("round-trips populated state, evidence, metadata, and sentiment", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    const created = await store.upsert(
      edgeInput({
        relationshipId: "rel_full",
        metadata: { role: "engineer", cadenceDays: 14 },
        state: {
          lastObservedAt: "2026-05-01T00:00:00.000Z",
          lastInteractionAt: "2026-05-02T00:00:00.000Z",
          interactionCount: 3,
          sentimentTrend: "positive",
        },
        evidence: ["msg-1", "msg-2"],
        confidence: 0.81,
        source: "platform_observation",
      }),
    );
    expect(created).toMatchObject({
      relationshipId: "rel_full",
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      metadata: { role: "engineer", cadenceDays: 14 },
      state: {
        lastObservedAt: "2026-05-01T00:00:00.000Z",
        lastInteractionAt: "2026-05-02T00:00:00.000Z",
        interactionCount: 3,
        sentimentTrend: "positive",
      },
      evidence: ["msg-1", "msg-2"],
      confidence: 0.81,
      source: "platform_observation",
      status: "active",
    });
    await expect(store.get("rel_full")).resolves.toEqual(created);
  });

  it("preserves createdAt and status on conflict, and omits zero interactionCount", async () => {
    const tables = createTables();
    const store = new RelationshipStore(
      createRuntime("agent-1", tables),
      "agent-1",
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_keep",
        status: "active",
        state: { interactionCount: 0, sentimentTrend: "neutral" },
      }),
    );
    vi.setSystemTime(new Date("2026-06-01T12:00:05.000Z"));
    const updated = await store.upsert(
      edgeInput({
        relationshipId: "rel_keep",
        fromEntityId: "from-z",
        type: "friend_of",
        confidence: 0.9,
        evidence: ["later"],
      }),
    );
    expect(updated.createdAt).toBe("2026-06-01T12:00:00.000Z");
    expect(updated.updatedAt).toBe("2026-06-01T12:00:05.000Z");
    expect(updated.fromEntityId).toBe("from-z");
    expect(updated.type).toBe("friend_of");
    expect(updated.status).toBe("active");
    expect(updated.state.interactionCount).toBeUndefined();
    expect(updated.state.sentimentTrend).toBeUndefined();
  });

  it("keeps an existing retired status when the upsert omits status", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(
      edgeInput({ relationshipId: "rel_ret", status: "retired" }),
    );
    const updated = await store.upsert(
      edgeInput({ relationshipId: "rel_ret", confidence: 0.2 }),
    );
    expect(updated.status).toBe("retired");
  });

  it("throws when the inserted row cannot be read back", async () => {
    const runtime = {
      adapter: {
        db: {
          execute: async () => ({ rows: [] }),
        },
      },
    } as unknown as IAgentRuntime;
    const store = new RelationshipStore(runtime, "agent-1");
    await expect(store.upsert(edgeInput())).rejects.toThrow(
      /failed to read back upserted relationship/,
    );
  });

  it("scopes reads to the store agentId", async () => {
    const tables = createTables();
    const storeA = new RelationshipStore(
      createRuntime("agent-a", tables),
      "agent-a",
    );
    const storeB = new RelationshipStore(
      createRuntime("agent-b", tables),
      "agent-b",
    );
    await storeA.upsert(edgeInput({ relationshipId: "rel_shared" }));
    await expect(storeB.get("rel_shared")).resolves.toBeNull();
    await expect(storeB.list()).resolves.toEqual([]);
    await expect(storeA.get("rel_shared")).resolves.toMatchObject({
      relationshipId: "rel_shared",
    });
  });

  it("lists the empty set, a single element, and DESC updated_at order", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await expect(store.list()).resolves.toEqual([]);

    await store.upsert(edgeInput({ relationshipId: "rel_old" }));
    const single = await store.list();
    expect(single).toHaveLength(1);
    expect(single[0]?.relationshipId).toBe("rel_old");

    vi.setSystemTime(new Date("2026-06-01T12:00:02.000Z"));
    await store.upsert(
      edgeInput({ relationshipId: "rel_new", toEntityId: "to-c" }),
    );
    expect((await store.list()).map((rel) => rel.relationshipId)).toEqual([
      "rel_new",
      "rel_old",
    ]);
  });

  it("excludes retired edges unless includeRetired is set", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(edgeInput({ relationshipId: "rel_live" }));
    await store.upsert(
      edgeInput({ relationshipId: "rel_gone", toEntityId: "to-x" }),
    );
    await store.retire("rel_gone", "no longer relevant");

    const active = await store.list();
    expect(active.map((rel) => rel.relationshipId)).toEqual(["rel_live"]);

    const all = await store.list({ includeRetired: true });
    expect(all.map((rel) => rel.relationshipId).sort()).toEqual([
      "rel_gone",
      "rel_live",
    ]);
    const retired = await store.get("rel_gone");
    expect(retired?.status).toBe("retired");
    expect(retired?.retiredAt).toBe("2026-06-01T12:00:00.000Z");
    expect(retired?.retiredReason).toBe("no longer relevant");
  });

  it("filters by from, to, type string, type array, and quoted identifiers", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_quote",
        fromEntityId: "o'reilly",
        toEntityId: "pat's",
        type: "friend_of",
      }),
    );
    vi.setSystemTime(new Date("2026-06-01T12:00:01.000Z"));
    await store.upsert(
      edgeInput({
        relationshipId: "rel_work",
        fromEntityId: "o'reilly",
        toEntityId: "acme",
        type: "works_at",
      }),
    );
    vi.setSystemTime(new Date("2026-06-01T12:00:02.000Z"));
    await store.upsert(
      edgeInput({
        relationshipId: "rel_other",
        fromEntityId: "other",
        type: "knows",
      }),
    );

    expect(
      (await store.list({ fromEntityId: "o'reilly" })).map(
        (rel) => rel.relationshipId,
      ),
    ).toEqual(["rel_work", "rel_quote"]);
    expect(
      (await store.list({ toEntityId: "pat's" })).map(
        (rel) => rel.relationshipId,
      ),
    ).toEqual(["rel_quote"]);
    expect(
      (await store.list({ type: "works_at" })).map((rel) => rel.relationshipId),
    ).toEqual(["rel_work"]);
    expect(
      (await store.list({ type: ["friend_of", "knows"] })).map(
        (rel) => rel.relationshipId,
      ),
    ).toEqual(["rel_other", "rel_quote"]);
    expect(await store.list({ type: "" })).toHaveLength(3);
  });

  it("applies a finite integer limit in SQL and ignores non-finite limits", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(edgeInput({ relationshipId: "rel_a" }));
    vi.setSystemTime(new Date("2026-06-01T12:00:01.000Z"));
    await store.upsert(
      edgeInput({ relationshipId: "rel_b", toEntityId: "to-c" }),
    );
    vi.setSystemTime(new Date("2026-06-01T12:00:02.000Z"));
    await store.upsert(
      edgeInput({ relationshipId: "rel_c", toEntityId: "to-d" }),
    );

    expect(
      (await store.list({ limit: 1 })).map((rel) => rel.relationshipId),
    ).toEqual(["rel_c"]);
    expect(await store.list({ limit: 0 })).toEqual([]);
    expect(
      (await store.list({ limit: 1.9 })).map((rel) => rel.relationshipId),
    ).toEqual(["rel_c"]);
    expect(await store.list({ limit: Number.NaN })).toHaveLength(3);
    expect(await store.list({ limit: Number.POSITIVE_INFINITY })).toHaveLength(
      3,
    );
  });

  it("matches metadata in memory after the SQL limit, including omitted empty metadata", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_keep",
        metadata: { role: "keep", city: "sf" },
      }),
    );
    vi.setSystemTime(new Date("2026-06-01T12:00:01.000Z"));
    await store.upsert(
      edgeInput({
        relationshipId: "rel_skip",
        toEntityId: "to-c",
        metadata: { role: "skip" },
      }),
    );
    vi.setSystemTime(new Date("2026-06-01T12:00:02.000Z"));
    await store.upsert(
      edgeInput({ relationshipId: "rel_empty", toEntityId: "to-d" }),
    );

    expect(
      (await store.list({ metadataMatch: { role: "keep" } })).map(
        (rel) => rel.relationshipId,
      ),
    ).toEqual(["rel_keep"]);
    expect(
      await store.list({ metadataMatch: { role: "keep", city: "sf" } }),
    ).toHaveLength(1);
    expect(
      await store.list({ metadataMatch: { role: "keep", city: "ny" } }),
    ).toEqual([]);
    expect(
      await store.list({ metadataMatch: { role: "keep" }, limit: 1 }),
    ).toEqual([]);
    expect(
      (await store.list({ metadataMatch: { missing: null } })).map(
        (rel) => rel.relationshipId,
      ),
    ).toEqual(["rel_skip", "rel_keep"]);
  });

  it("filters cadence-overdue edges, including the invalid-asOf empty-queue path", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_overdue",
        metadata: { cadenceDays: 7.9 },
        state: { lastInteractionAt: "2026-05-20T12:00:00.000Z" },
      }),
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_fresh",
        toEntityId: "to-c",
        metadata: { cadenceDays: 7 },
        state: { lastInteractionAt: "2026-05-30T12:00:00.000Z" },
      }),
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_never",
        toEntityId: "to-d",
        metadata: { cadenceDays: 3 },
      }),
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_nocadence",
        toEntityId: "to-e",
        metadata: { cadenceDays: 0 },
        state: { lastInteractionAt: "2020-01-01T00:00:00.000Z" },
      }),
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_badlast",
        toEntityId: "to-f",
        metadata: { cadenceDays: 1 },
        state: { lastInteractionAt: "not-a-date" },
      }),
    );

    const asOf = "2026-06-01T12:00:00.000Z";
    expect(
      (await store.list({ cadenceOverdueAsOf: asOf }))
        .map((rel) => rel.relationshipId)
        .sort(),
    ).toEqual(["rel_never", "rel_overdue"]);
    expect(await store.list({ cadenceOverdueAsOf: "not-a-date" })).toEqual([]);
  });

  it("creates a new edge on observe with extraction source and copied evidence", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    const created = await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["ev-1"],
      confidence: 0.55,
      metadataPatch: { role: "neighbor" },
    });
    expect(created.status).toBe("active");
    expect(created.source).toBe("extraction");
    expect(created.evidence).toEqual(["ev-1"]);
    expect(created.metadata).toEqual({ role: "neighbor" });
    expect(created.state).toEqual({
      lastObservedAt: "2026-06-01T12:00:00.000Z",
      lastInteractionAt: "2026-06-01T12:00:00.000Z",
      interactionCount: 1,
    });
  });

  it("strengthens an active match: unique evidence, max confidence, bumped count", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(
      edgeInput({
        relationshipId: "rel_active",
        metadata: { role: "old" },
        evidence: ["a", "b"],
        confidence: 0.3,
        source: "user_chat",
        state: { interactionCount: 2, sentimentTrend: "neutral" },
      }),
    );
    vi.setSystemTime(new Date("2026-06-01T13:00:00.000Z"));
    const updated = await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["b", "c"],
      confidence: 0.8,
      occurredAt: "2026-06-01T13:00:00.000Z",
      metadataPatch: { cadenceDays: 14 },
    });
    expect(updated.relationshipId).toBe("rel_active");
    expect(updated.evidence).toEqual(["a", "b", "c"]);
    expect(updated.confidence).toBe(0.8);
    expect(updated.source).toBe("user_chat");
    expect(updated.metadata).toEqual({ role: "old", cadenceDays: 14 });
    expect(updated.state.interactionCount).toBe(3);
    expect(updated.state.lastInteractionAt).toBe("2026-06-01T13:00:00.000Z");
    expect(updated.state.lastObservedAt).toBe("2026-06-01T13:00:00.000Z");
    expect(updated.state.sentimentTrend).toBe("neutral");

    const lower = await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["d"],
      confidence: 0.1,
      source: "import",
      occurredAt: "2026-06-01T14:00:00.000Z",
    });
    expect(lower.confidence).toBe(0.8);
    expect(lower.source).toBe("import");
    expect(lower.evidence).toEqual(["a", "b", "c", "d"]);
    expect(lower.state.interactionCount).toBe(4);
  });

  it("logs observe-on-retired without flipping status or timestamps", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(edgeInput({ relationshipId: "rel_dead" }));
    await store.retire("rel_dead", "ended");
    const retired = await store.get("rel_dead");
    if (!retired) throw new Error("expected retired edge");

    vi.setSystemTime(new Date("2026-06-01T15:00:00.000Z"));
    const observed = await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["after-retire"],
      confidence: 0.99,
    });
    expect(observed).toEqual(retired);
    expect(observed.status).toBe("retired");
    expect(observed.evidence).toEqual([]);
    expect(observed.updatedAt).toBe("2026-06-01T12:00:00.000Z");

    const events = await store.listAuditEvents("rel_dead");
    expect(events.map((event) => event.kind)).toEqual([
      "retire",
      "observe_on_retired",
    ]);
    expect(events[1]?.details).toEqual({
      evidence: ["after-retire"],
      confidence: 0.99,
      occurredAt: "2026-06-01T15:00:00.000Z",
    });
    expect(events[0]?.id).toMatch(/^raud_/);
  });

  it("prefers the active edge when a retired triple also exists", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await store.upsert(edgeInput({ relationshipId: "rel_old" }));
    await store.retire("rel_old", "superseded");
    await store.upsert(
      edgeInput({
        relationshipId: "rel_live",
        evidence: ["live"],
        confidence: 0.2,
      }),
    );

    const observed = await store.observe({
      fromEntityId: "from-a",
      toEntityId: "to-b",
      type: "knows",
      evidence: ["new"],
      confidence: 0.5,
    });
    expect(observed.relationshipId).toBe("rel_live");
    expect(observed.status).toBe("active");
    expect(observed.evidence).toEqual(["live", "new"]);
    expect((await store.get("rel_old"))?.status).toBe("retired");
  });

  it("throws when retiring a missing id and returns no audit rows for it", async () => {
    const store = new RelationshipStore(
      createRuntime("agent-1", createTables()),
      "agent-1",
    );
    await expect(store.retire("rel_missing", "gone")).rejects.toThrow(
      /relationship rel_missing not found/,
    );
    await expect(store.listAuditEvents("rel_missing")).resolves.toEqual([]);
  });

  it("throws when the runtime database adapter is unavailable", async () => {
    const store = new RelationshipStore(
      { adapter: {} } as unknown as IAgentRuntime,
      "agent-1",
    );
    await expect(store.get("rel_x")).rejects.toThrow(
      "runtime database adapter unavailable",
    );
  });
});
