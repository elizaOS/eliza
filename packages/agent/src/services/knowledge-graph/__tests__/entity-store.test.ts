/**
 * Behavioral unit coverage for EntityStore against a deterministic in-memory
 * SQL adapter. Drives the real store: drizzle `sql.raw` still builds the query
 * object, and assertions read rows the store persisted, not values a mock
 * was programmed to echo.
 */

import type { IAgentRuntime } from "@elizaos/core";
import {
  type EntityAttribute,
  type EntityIdentity,
  SELF_ENTITY_ID,
} from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_MERGE_CONFIDENCE_THRESHOLD,
  EntityStore,
} from "../entity-store.ts";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const T0 = "2026-08-23T12:00:00.000Z";
const T1 = "2026-08-23T12:00:05.000Z";
const T2 = "2026-08-23T12:00:10.000Z";

type QueryChunks = {
  queryChunks: Array<{ value?: unknown }>;
};

function extractSql(query: QueryChunks): string {
  return query.queryChunks
    .flatMap((chunk) =>
      Array.isArray(chunk.value) ? chunk.value : [chunk.value],
    )
    .filter((value): value is string => typeof value === "string")
    .join("");
}

function findMatchingParen(sql: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIdx; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'" && sql[i + 1] === "'") {
        i += 1;
        continue;
      }
      if (ch === "'") inString = false;
      continue;
    }
    if (ch === "'") {
      inString = true;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitSqlList(inner: string): string[] {
  const out: string[] = [];
  let current = "";
  let inString = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (inner[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === ",") {
      const trimmed = current.trim();
      if (trimmed) out.push(trimmed);
      current = "";
      continue;
    }
    current += ch;
  }
  const trimmed = current.trim();
  if (trimmed) out.push(trimmed);
  return out;
}

function decodeSqlLiteral(raw: string): unknown {
  const value = raw.trim();
  if (value === "NULL") return null;
  if (value === "TRUE") return true;
  if (value === "FALSE") return false;
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  const asNumber = Number(value);
  if (value !== "" && Number.isFinite(asNumber)) return asNumber;
  return value;
}

function quotedEquals(sql: string, column: string): string | undefined {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(new RegExp(`${escaped}\\s*=\\s*'((?:[^']|'')*)'`));
  return match?.[1]?.replace(/''/g, "'");
}

function likePattern(sql: string, column: string): string | undefined {
  const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = sql.match(
    new RegExp(`${escaped}\\s+LIKE\\s+'((?:[^']|'')*)'`, "i"),
  );
  return match?.[1]?.replace(/''/g, "'");
}

function sqlLike(value: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/%/g, ".*")
    .replace(/_/g, ".");
  return new RegExp(`^${escaped}$`).test(value);
}

function parseInsert(sql: string): {
  table: string;
  row: Record<string, unknown>;
  conflictUpdateColumns: string[];
} {
  const header = sql.match(/INSERT INTO ([\w.]+)\s*\(/i);
  if (!header || header.index === undefined) {
    throw new Error(`unparseable INSERT: ${sql}`);
  }
  const table = header[1] ?? "";
  const colOpen = header.index + header[0].length - 1;
  const colClose = findMatchingParen(sql, colOpen);
  const columns = splitSqlList(sql.slice(colOpen + 1, colClose));
  const afterCols = sql.slice(colClose + 1);
  const valuesKw = afterCols.match(/VALUES\s*\(/i);
  if (!valuesKw || valuesKw.index === undefined) {
    throw new Error(`INSERT missing VALUES: ${sql}`);
  }
  const valOpen = valuesKw.index + valuesKw[0].length - 1;
  const valClose = findMatchingParen(afterCols, valOpen);
  const values = splitSqlList(afterCols.slice(valOpen + 1, valClose)).map(
    decodeSqlLiteral,
  );
  const row: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i += 1) {
    const column = columns[i];
    if (column) row[column] = values[i] ?? null;
  }
  const rest = afterCols.slice(valClose + 1);
  const conflictUpdateColumns = [
    ...rest.matchAll(/(\w+)\s*=\s*EXCLUDED\.\w+/gi),
  ].map((match) => match[1] ?? "");
  return { table, row, conflictUpdateColumns };
}

function parseAssignments(sql: string): Record<string, unknown> {
  const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
  if (!setMatch?.[1]) return {};
  const assignments: Record<string, unknown> = {};
  for (const part of splitSqlList(setMatch[1])) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const column = part.slice(0, eq).trim();
    assignments[column] = decodeSqlLiteral(part.slice(eq + 1));
  }
  return assignments;
}

function parseWhereEquals(sql: string): Record<string, string> {
  const whereMatch = sql.match(/WHERE\s+([\s\S]+)$/i);
  if (!whereMatch?.[1]) return {};
  const where: Record<string, string> = {};
  for (const part of whereMatch[1].split(/\s+AND\s+/i)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const column = part.slice(0, eq).trim();
    const value = decodeSqlLiteral(part.slice(eq + 1));
    if (typeof value === "string") where[column] = value;
  }
  return where;
}

function inList(sql: string): string[] | undefined {
  const match = sql.match(/entity_id IN\s*\(/i);
  if (!match || match.index === undefined) return undefined;
  const open = match.index + match[0].length - 1;
  const close = findMatchingParen(sql, open);
  return splitSqlList(sql.slice(open + 1, close)).map((item) =>
    String(decodeSqlLiteral(item)),
  );
}

class MemoryKnowledgeGraph {
  entities: Array<Record<string, unknown>> = [];
  identities: Array<Record<string, unknown>> = [];
  attributes: Array<Record<string, unknown>> = [];
  relationships: Array<Record<string, unknown>> = [];
  omitExistingEntityRows = false;

  execute = async (
    query: QueryChunks,
  ): Promise<{ rows: Array<Record<string, unknown>> }> => {
    return { rows: this.dispatch(extractSql(query)) };
  };

  private upsert(
    table: Array<Record<string, unknown>>,
    incoming: Record<string, unknown>,
    keyCols: string[],
    updateCols: string[],
  ): void {
    const existing = table.find((row) =>
      keyCols.every((col) => row[col] === incoming[col]),
    );
    if (!existing) {
      table.push({ ...incoming });
      return;
    }
    for (const col of updateCols) {
      existing[col] = incoming[col];
    }
  }

  private dispatch(sql: string): Array<Record<string, unknown>> {
    if (/INSERT INTO app_lifeops\.life_entities\b/i.test(sql)) {
      const parsed = parseInsert(sql);
      this.upsert(
        this.entities,
        parsed.row,
        ["agent_id", "entity_id"],
        parsed.conflictUpdateColumns,
      );
      return [];
    }
    if (/INSERT INTO app_lifeops\.life_entity_identities\b/i.test(sql)) {
      const parsed = parseInsert(sql);
      this.upsert(
        this.identities,
        parsed.row,
        ["agent_id", "entity_id", "platform", "connector_account_id", "handle"],
        parsed.conflictUpdateColumns,
      );
      return [];
    }
    if (/INSERT INTO app_lifeops\.life_entity_attributes\b/i.test(sql)) {
      const parsed = parseInsert(sql);
      this.upsert(
        this.attributes,
        parsed.row,
        ["agent_id", "entity_id", "key"],
        parsed.conflictUpdateColumns,
      );
      return [];
    }
    if (/DELETE FROM app_lifeops\.life_entity_identities\b/i.test(sql)) {
      const where = parseWhereEquals(sql);
      this.identities = this.identities.filter(
        (row) =>
          !(
            row.agent_id === where.agent_id && row.entity_id === where.entity_id
          ),
      );
      return [];
    }
    if (/DELETE FROM app_lifeops\.life_entity_attributes\b/i.test(sql)) {
      const where = parseWhereEquals(sql);
      this.attributes = this.attributes.filter(
        (row) =>
          !(
            row.agent_id === where.agent_id && row.entity_id === where.entity_id
          ),
      );
      return [];
    }
    if (/DELETE FROM app_lifeops\.life_entities\b/i.test(sql)) {
      const where = parseWhereEquals(sql);
      this.entities = this.entities.filter(
        (row) =>
          !(
            row.agent_id === where.agent_id && row.entity_id === where.entity_id
          ),
      );
      return [];
    }
    if (/UPDATE app_lifeops\.life_entities\b/i.test(sql)) {
      const where = parseWhereEquals(sql);
      const assignments = parseAssignments(sql);
      for (const row of this.entities) {
        if (
          row.agent_id === where.agent_id &&
          row.entity_id === where.entity_id
        ) {
          Object.assign(row, assignments);
        }
      }
      return [];
    }
    if (/UPDATE app_lifeops\.life_relationships_v2\b/i.test(sql)) {
      const where = parseWhereEquals(sql);
      const assignments = parseAssignments(sql);
      for (const row of this.relationships) {
        if (row.agent_id !== where.agent_id) continue;
        if (
          where.from_entity_id !== undefined &&
          row.from_entity_id === where.from_entity_id
        ) {
          Object.assign(row, assignments);
        }
        if (
          where.to_entity_id !== undefined &&
          row.to_entity_id === where.to_entity_id
        ) {
          Object.assign(row, assignments);
        }
      }
      return [];
    }
    if (/SELECT e\.\* FROM app_lifeops\.life_entities e\b/i.test(sql)) {
      return this.selectEntities(sql);
    }
    if (/SELECT \* FROM app_lifeops\.life_entities\b/i.test(sql)) {
      const agentId = quotedEquals(sql, "agent_id");
      const entityId = quotedEquals(sql, "entity_id");
      const rows = this.entities.filter(
        (row) => row.agent_id === agentId && row.entity_id === entityId,
      );
      if (this.omitExistingEntityRows && rows.length > 0) {
        this.omitExistingEntityRows = false;
        return [];
      }
      return rows;
    }
    if (/SELECT \* FROM app_lifeops\.life_entity_identities\b/i.test(sql)) {
      const agentId = quotedEquals(sql, "agent_id");
      const ids = inList(sql) ?? [];
      return this.identities
        .filter(
          (row) =>
            row.agent_id === agentId && ids.includes(String(row.entity_id)),
        )
        .sort((a, b) =>
          String(a.added_at ?? "").localeCompare(String(b.added_at ?? "")),
        );
    }
    if (/SELECT \* FROM app_lifeops\.life_entity_attributes\b/i.test(sql)) {
      const agentId = quotedEquals(sql, "agent_id");
      const ids = inList(sql) ?? [];
      return this.attributes.filter(
        (row) =>
          row.agent_id === agentId && ids.includes(String(row.entity_id)),
      );
    }
    throw new Error(`unsupported SQL in EntityStore test harness: ${sql}`);
  }

  private selectEntities(sql: string): Array<Record<string, unknown>> {
    const agentId =
      quotedEquals(sql, "e.agent_id") ?? quotedEquals(sql, "agent_id");
    const type = quotedEquals(sql, "e.type");
    const tagLike = likePattern(sql, "e.tags_json");
    const nameLike = likePattern(sql, "LOWER(e.preferred_name)");
    const platform = quotedEquals(sql, "LOWER(i.platform)");
    const account = quotedEquals(sql, "i.connector_account_id");
    const hasIdentityExists = /EXISTS\s*\(/i.test(sql);
    const limitMatch = sql.match(/LIMIT\s+(\d+)\s*$/i);
    const limit = limitMatch?.[1] ? Number(limitMatch[1]) : undefined;

    let rows = this.entities.filter((row) => row.agent_id === agentId);
    if (type !== undefined) {
      rows = rows.filter((row) => row.type === type);
    }
    if (tagLike !== undefined) {
      rows = rows.filter((row) =>
        sqlLike(String(row.tags_json ?? ""), tagLike),
      );
    }
    if (nameLike !== undefined) {
      rows = rows.filter((row) => {
        const preferred = String(row.preferred_name ?? "").toLowerCase();
        const full = String(row.full_name ?? "").toLowerCase();
        return sqlLike(preferred, nameLike) || sqlLike(full, nameLike);
      });
    }
    if (hasIdentityExists) {
      rows = rows.filter((row) =>
        this.identities.some((identity) => {
          if (
            identity.agent_id !== row.agent_id ||
            identity.entity_id !== row.entity_id
          ) {
            return false;
          }
          if (
            platform !== undefined &&
            String(identity.platform).toLowerCase() !== platform
          ) {
            return false;
          }
          if (
            account !== undefined &&
            identity.connector_account_id !== account
          ) {
            return false;
          }
          return true;
        }),
      );
    }
    rows = [...rows].sort((a, b) =>
      String(a.preferred_name ?? "").localeCompare(
        String(b.preferred_name ?? ""),
      ),
    );
    if (typeof limit === "number") rows = rows.slice(0, limit);
    return rows;
  }
}

function createHarness(opts?: {
  agentId?: string;
  kg?: MemoryKnowledgeGraph;
}): {
  store: EntityStore;
  kg: MemoryKnowledgeGraph;
} {
  const kg = opts?.kg ?? new MemoryKnowledgeGraph();
  const runtime = {
    adapter: { db: { execute: kg.execute } },
  } as IAgentRuntime;
  return {
    store: new EntityStore(runtime, opts?.agentId ?? AGENT_A),
    kg,
  };
}

function identity(
  overrides: Partial<EntityIdentity> &
    Pick<EntityIdentity, "platform" | "handle">,
): EntityIdentity {
  return {
    connectorAccountId: "default",
    verified: false,
    confidence: 0.9,
    addedAt: T0,
    addedVia: "platform_observation",
    evidence: ["obs-1"],
    ...overrides,
  };
}

function attribute(overrides: Partial<EntityAttribute> = {}): EntityAttribute {
  return {
    value: "engineer",
    confidence: 0.7,
    evidence: ["attr-1"],
    updatedAt: T0,
    ...overrides,
  };
}

describe("EntityStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-exports the shared auto-merge confidence threshold", () => {
    expect(AUTO_MERGE_CONFIDENCE_THRESHOLD).toBe(0.85);
  });

  it("throws when the runtime has no database adapter", async () => {
    const store = new EntityStore({ adapter: {} } as IAgentRuntime, AGENT_A);
    await expect(store.get("missing")).rejects.toThrow(
      "runtime database adapter unavailable",
    );
  });

  it("returns null for a missing entity id", async () => {
    const { store } = createHarness();
    await expect(store.get("no-such-entity")).resolves.toBeNull();
  });

  it("creates the self entity once and returns the same row on later calls", async () => {
    const { store } = createHarness();
    const first = await store.ensureSelf();
    expect(first).toMatchObject({
      entityId: SELF_ENTITY_ID,
      type: "person",
      preferredName: "self",
      identities: [],
      tags: [],
      visibility: "owner_only",
      state: {},
      createdAt: T0,
      updatedAt: T0,
    });
    expect(first.fullName).toBeUndefined();
    expect(first.attributes).toBeUndefined();

    vi.setSystemTime(new Date(T1));
    const second = await store.ensureSelf();
    expect(second.createdAt).toBe(T0);
    expect(second.updatedAt).toBe(T0);
    expect(second.entityId).toBe(SELF_ENTITY_ID);
  });

  it("generates an ent_ uuid when upsert is not given an entity id", async () => {
    const { store } = createHarness();
    const created = await store.upsert({
      type: "person",
      preferredName: "Alice",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    expect(created.entityId).toMatch(/^ent_[0-9a-f-]{36}$/i);
    await expect(store.get(created.entityId)).resolves.toEqual(created);
  });

  it("round-trips identities, attributes, tags, full name, and state", async () => {
    const { store } = createHarness();
    const created = await store.upsert({
      entityId: "ent-alice",
      type: "person",
      preferredName: "Alice",
      fullName: "Alice O'Brien",
      identities: [
        identity({
          platform: "slack",
          handle: "@alice",
          displayName: "Alice O",
          verified: true,
          confidence: 0.95,
          connectorAccountId: "  acct-1  ",
        }),
        identity({
          platform: "email",
          handle: "alice@example.com",
          addedAt: T1,
        }),
      ],
      attributes: {
        role: attribute({ value: { title: "eng" } }),
      },
      tags: ["friend", "work"],
      visibility: "owner_only",
      state: {
        lastObservedAt: T0,
        lastInboundAt: T0,
        lastOutboundAt: T1,
        lastInteractionPlatform: "slack",
      },
    });

    expect(created.fullName).toBe("Alice O'Brien");
    expect(created.identities).toHaveLength(2);
    expect(created.identities[0]).toMatchObject({
      platform: "slack",
      handle: "@alice",
      displayName: "Alice O",
      verified: true,
      confidence: 0.95,
      connectorAccountId: "acct-1",
      addedVia: "platform_observation",
      evidence: ["obs-1"],
    });
    expect(created.identities[1]?.displayName).toBeUndefined();
    expect(created.attributes?.role).toEqual({
      value: { title: "eng" },
      confidence: 0.7,
      evidence: ["attr-1"],
      updatedAt: T0,
    });
    expect(created.tags).toEqual(["friend", "work"]);
    expect(created.state).toEqual({
      lastObservedAt: T0,
      lastInboundAt: T0,
      lastOutboundAt: T1,
      lastInteractionPlatform: "slack",
    });
  });

  it("preserves createdAt on upsert conflict and replaces identities wholesale", async () => {
    const { store } = createHarness();
    const first = await store.upsert({
      entityId: "ent-alice",
      type: "person",
      preferredName: "Alice",
      identities: [identity({ platform: "slack", handle: "@old" })],
      tags: ["old"],
      visibility: "owner_agent_admin",
      state: {},
    });
    vi.setSystemTime(new Date(T1));
    const updated = await store.upsert({
      entityId: "ent-alice",
      type: "organization",
      preferredName: "Alice Inc",
      identities: [identity({ platform: "email", handle: "a@x.com" })],
      tags: ["new"],
      visibility: "owner_only",
      state: { lastObservedAt: T1 },
    });
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt).toBe(T1);
    expect(updated.type).toBe("organization");
    expect(updated.preferredName).toBe("Alice Inc");
    expect(updated.identities).toHaveLength(1);
    expect(updated.identities[0]?.handle).toBe("a@x.com");
    expect(updated.tags).toEqual(["new"]);
  });

  it("throws when an upsert cannot be read back", async () => {
    const { store, kg } = createHarness();
    kg.omitExistingEntityRows = true;
    await expect(
      store.upsert({
        entityId: "ent-ghost",
        type: "person",
        preferredName: "Ghost",
        identities: [],
        tags: [],
        visibility: "owner_agent_admin",
        state: {},
      }),
    ).rejects.toThrow(
      "[EntityStore] failed to read back upserted entity ent-ghost",
    );
  });

  it("lists an empty graph as an empty array", async () => {
    const { store } = createHarness();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("lists entities ordered by preferred name and applies type, tag, name, identity, and limit filters", async () => {
    const { store } = createHarness();
    await store.upsert({
      entityId: "ent-c",
      type: "person",
      preferredName: "Carla",
      identities: [
        identity({
          platform: "Slack",
          handle: "@carla",
          connectorAccountId: "acct-c",
        }),
      ],
      tags: ["friend"],
      visibility: "owner_agent_admin",
      state: {},
    });
    await store.upsert({
      entityId: "ent-a",
      type: "person",
      preferredName: "Alice",
      fullName: "Alice Smith",
      identities: [
        identity({
          platform: "email",
          handle: "alice@x.com",
          connectorAccountId: "acct-a",
        }),
      ],
      tags: ["work"],
      visibility: "owner_agent_admin",
      state: {},
    });
    await store.upsert({
      entityId: "ent-org",
      type: "organization",
      preferredName: "Beta Labs",
      identities: [],
      tags: ["work"],
      visibility: "owner_agent_admin",
      state: {},
    });

    const all = await store.list();
    expect(all.map((entity) => entity.entityId)).toEqual([
      "ent-a",
      "ent-org",
      "ent-c",
    ]);

    const people = await store.list({ type: "person" });
    expect(people.map((entity) => entity.entityId)).toEqual(["ent-a", "ent-c"]);

    const tagged = await store.list({ tag: "friend" });
    expect(tagged.map((entity) => entity.entityId)).toEqual(["ent-c"]);

    const byPreferred = await store.list({ nameContains: "ALI" });
    expect(byPreferred.map((entity) => entity.entityId)).toEqual(["ent-a"]);

    const byFull = await store.list({ nameContains: "smith" });
    expect(byFull.map((entity) => entity.entityId)).toEqual(["ent-a"]);

    const byPlatform = await store.list({ hasPlatform: "SLACK" });
    expect(byPlatform.map((entity) => entity.entityId)).toEqual(["ent-c"]);

    const byAccount = await store.list({ hasConnectorAccountId: "acct-a" });
    expect(byAccount.map((entity) => entity.entityId)).toEqual(["ent-a"]);

    const byBoth = await store.list({
      hasPlatform: "slack",
      hasConnectorAccountId: "acct-c",
    });
    expect(byBoth.map((entity) => entity.entityId)).toEqual(["ent-c"]);

    const limited = await store.list({ limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((entity) => entity.entityId)).toEqual([
      "ent-a",
      "ent-org",
    ]);

    const unbounded = await store.list({ limit: Number.NaN });
    expect(unbounded).toHaveLength(3);

    const none = await store.list({ type: "place" });
    expect(none).toEqual([]);
  });

  it("isolates rows by agent id", async () => {
    const { store: storeA, kg } = createHarness({ agentId: AGENT_A });
    const { store: storeB } = createHarness({ agentId: AGENT_B, kg });
    await storeA.upsert({
      entityId: "ent-a",
      type: "person",
      preferredName: "Alice",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    await expect(storeB.get("ent-a")).resolves.toBeNull();
    await expect(storeB.list()).resolves.toEqual([]);
  });

  it("creates a new entity when observeIdentity finds no candidate", async () => {
    const { store } = createHarness();
    const result = await store.observeIdentity({
      platform: "slack",
      handle: "@alice",
      evidence: ["ev-1"],
      confidence: 0.4,
    });
    expect(result.conflict).toBeUndefined();
    expect(result.mergedFrom).toBeUndefined();
    expect(result.entity.preferredName).toBe("@alice");
    expect(result.entity.type).toBe("person");
    expect(result.entity.visibility).toBe("owner_agent_admin");
    expect(result.entity.state.lastObservedAt).toBe(T0);
    expect(result.entity.identities[0]).toMatchObject({
      platform: "slack",
      handle: "@alice",
      connectorAccountId: "default",
      verified: false,
      confidence: 0.4,
      addedVia: "platform_observation",
      evidence: ["ev-1"],
    });
    expect(result.entity.identities[0]?.displayName).toBeUndefined();
  });

  it("uses displayName and suggestedType on create observations", async () => {
    const { store } = createHarness();
    const result = await store.observeIdentity({
      platform: "github",
      handle: "alice",
      displayName: "Alice",
      suggestedType: "organization",
      connectorAccountId: "acct-1",
      evidence: ["ev-2"],
      confidence: 0.2,
    });
    expect(result.entity.preferredName).toBe("Alice");
    expect(result.entity.type).toBe("organization");
    expect(result.entity.identities[0]?.displayName).toBe("Alice");
    expect(result.entity.identities[0]?.connectorAccountId).toBe("acct-1");
  });

  it("auto-merges a single candidate at the confidence threshold", async () => {
    const { store } = createHarness();
    await store.upsert({
      entityId: "ent-alice",
      type: "person",
      preferredName: "Alice",
      identities: [
        identity({
          platform: "slack",
          handle: "@alice",
          evidence: ["old"],
          confidence: 0.5,
        }),
      ],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    vi.setSystemTime(new Date(T1));
    const result = await store.observeIdentity({
      platform: "SLACK",
      handle: "@ALICE",
      evidence: ["new"],
      confidence: AUTO_MERGE_CONFIDENCE_THRESHOLD,
    });
    expect(result.conflict).toBeUndefined();
    expect(result.mergedFrom).toEqual(["ent-alice"]);
    expect(result.entity.entityId).toBe("ent-alice");
    expect(result.entity.identities[0]?.evidence).toEqual(["old", "new"]);
    expect(result.entity.identities[0]?.confidence).toBe(
      AUTO_MERGE_CONFIDENCE_THRESHOLD,
    );
    expect(result.entity.state.lastObservedAt).toBe(T1);
  });

  it("returns a conflict for a single low-confidence candidate without writing the observation", async () => {
    const { store } = createHarness();
    await store.upsert({
      entityId: "ent-alice",
      type: "person",
      preferredName: "Alice",
      identities: [identity({ platform: "slack", handle: "@alice" })],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const result = await store.observeIdentity({
      platform: "slack",
      handle: "@alice",
      evidence: ["low"],
      confidence: 0.84,
    });
    expect(result.conflict).toBe(true);
    expect(result.mergedFrom).toEqual(["ent-alice"]);
    expect(result.entity.entityId).toBe("ent-alice");
    const persisted = await store.get("ent-alice");
    expect(persisted?.identities[0]?.evidence).toEqual(["obs-1"]);
  });

  it("returns a conflict listing every matching candidate, preferring the name-ordered first row", async () => {
    const { store } = createHarness();
    await store.upsert({
      entityId: "ent-b",
      type: "person",
      preferredName: "Bob",
      identities: [identity({ platform: "slack", handle: "@same" })],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    await store.upsert({
      entityId: "ent-a",
      type: "person",
      preferredName: "Ann",
      identities: [identity({ platform: "slack", handle: "@same" })],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const result = await store.observeIdentity({
      platform: "slack",
      handle: "@same",
      evidence: ["dup"],
      confidence: 0.99,
    });
    expect(result.conflict).toBe(true);
    expect(result.entity.entityId).toBe("ent-a");
    expect(result.mergedFrom).toEqual(["ent-a", "ent-b"]);
  });

  it("resolves by name with exact, partial, and non-matching confidence and verified-send safety", async () => {
    const { store } = createHarness();
    await store.upsert({
      entityId: "ent-1",
      type: "person",
      preferredName: "Alice",
      identities: [
        identity({ platform: "slack", handle: "@alice", verified: true }),
      ],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    await store.upsert({
      entityId: "ent-2",
      type: "person",
      preferredName: "Alice Smith",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    await store.upsert({
      entityId: "ent-3",
      type: "person",
      preferredName: "Bob",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    const candidates = await store.resolve({ name: "Alice" });
    expect(candidates.map((row) => row.entity.entityId)).toEqual([
      "ent-1",
      "ent-2",
    ]);
    expect(candidates[0]).toMatchObject({
      confidence: 0.9,
      safeToSend: true,
      evidence: [],
    });
    expect(candidates[1]).toMatchObject({
      confidence: 0.55,
      safeToSend: false,
      evidence: [],
    });
  });

  it("resolves identity matches case-insensitively, ranks by identity confidence, and uses the matched verified flag for safeToSend", async () => {
    const { store } = createHarness();
    await store.upsert({
      entityId: "ent-high",
      type: "person",
      preferredName: "High",
      identities: [
        identity({
          platform: "Slack",
          handle: "@Alice",
          confidence: 0.4,
          verified: false,
          evidence: ["id-high"],
        }),
        identity({
          platform: "email",
          handle: "other@x.com",
          verified: true,
        }),
      ],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    await store.upsert({
      entityId: "ent-low",
      type: "person",
      preferredName: "Low",
      identities: [
        identity({
          platform: "slack",
          handle: "@alice",
          confidence: 0.95,
          verified: true,
          evidence: ["id-low"],
        }),
      ],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    await store.upsert({
      entityId: "ent-other-handle",
      type: "person",
      preferredName: "Other",
      identities: [identity({ platform: "slack", handle: "@bob" })],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    const candidates = await store.resolve({
      identity: { platform: "SLACK", handle: "@ALICE" },
      type: "person",
    });
    expect(candidates.map((row) => row.entity.entityId)).toEqual([
      "ent-low",
      "ent-high",
    ]);
    expect(candidates[0]).toMatchObject({
      confidence: 0.95,
      safeToSend: true,
      evidence: ["id-low"],
    });
    expect(candidates[1]).toMatchObject({
      confidence: 0.4,
      safeToSend: false,
      evidence: ["id-high"],
    });
  });

  it("takes the max of identity and exact-name confidence when both query fields are present", async () => {
    const { store } = createHarness();
    await store.upsert({
      entityId: "ent-alice",
      type: "person",
      preferredName: "Alice",
      identities: [
        identity({
          platform: "slack",
          handle: "@alice",
          confidence: 0.2,
          evidence: ["weak"],
        }),
      ],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const candidates = await store.resolve({
      name: "Alice",
      identity: { platform: "slack", handle: "@alice" },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.confidence).toBe(0.9);
    expect(candidates[0]?.evidence).toEqual(["weak"]);
  });

  it("returns no resolve candidates when the graph is empty", async () => {
    const { store } = createHarness();
    await expect(store.resolve({ name: "Alice" })).resolves.toEqual([]);
  });

  it("records inbound and outbound interaction timestamps without clearing the other direction", async () => {
    const { store } = createHarness();
    await store.upsert({
      entityId: "ent-alice",
      type: "person",
      preferredName: "Alice",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    await store.recordInteraction("ent-alice", {
      platform: "slack",
      direction: "inbound",
      summary: "hi",
      occurredAt: T1,
    });
    vi.setSystemTime(new Date(T2));
    await store.recordInteraction("ent-alice", {
      platform: "email",
      direction: "outbound",
      summary: "reply",
      occurredAt: T2,
    });
    const entity = await store.get("ent-alice");
    expect(entity?.state).toEqual({
      lastObservedAt: T2,
      lastInboundAt: T1,
      lastOutboundAt: T2,
      lastInteractionPlatform: "email",
    });
    expect(entity?.updatedAt).toBe(T2);
  });

  it("silently no-ops recordInteraction for a missing entity", async () => {
    const { store } = createHarness();
    await expect(
      store.recordInteraction("missing", {
        platform: "slack",
        direction: "inbound",
        summary: "gone",
        occurredAt: T1,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns the existing target when merge is given an empty source list", async () => {
    const { store } = createHarness();
    await store.upsert({
      entityId: "ent-t",
      type: "person",
      preferredName: "Target",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const merged = await store.merge("ent-t", []);
    expect(merged.entityId).toBe("ent-t");
  });

  it("throws when merge target is missing, including the empty-source path", async () => {
    const { store } = createHarness();
    await expect(store.merge("missing", [])).rejects.toThrow(
      "[EntityStore.merge] target missing not found",
    );
    await expect(store.merge("missing", ["ent-x"])).rejects.toThrow(
      "[EntityStore.merge] target missing not found",
    );
  });

  it("folds identities, tags, and attributes then deletes sources and rewrites relationship endpoints", async () => {
    const { store, kg } = createHarness();
    await store.upsert({
      entityId: "ent-t",
      type: "person",
      preferredName: "Target",
      identities: [
        identity({ platform: "slack", handle: "@t", evidence: ["t"] }),
      ],
      attributes: { role: attribute({ value: "target", confidence: 0.4 }) },
      tags: ["keep", "alpha"],
      visibility: "owner_agent_admin",
      state: { lastObservedAt: T0, lastInboundAt: T0 },
    });
    await store.upsert({
      entityId: "ent-s",
      type: "person",
      preferredName: "Source",
      identities: [
        identity({
          platform: "email",
          handle: "s@x.com",
          evidence: ["s"],
        }),
      ],
      attributes: {
        role: attribute({
          value: "source",
          confidence: 0.9,
          evidence: ["s-role"],
        }),
        city: attribute({ value: "sf" }),
      },
      tags: ["beta"],
      visibility: "owner_agent_admin",
      state: { lastObservedAt: T1, lastOutboundAt: T1 },
    });
    kg.relationships.push(
      {
        relationship_id: "rel-from",
        agent_id: AGENT_A,
        from_entity_id: "ent-s",
        to_entity_id: "ent-other",
        updated_at: T0,
      },
      {
        relationship_id: "rel-to",
        agent_id: AGENT_A,
        from_entity_id: "ent-other",
        to_entity_id: "ent-s",
        updated_at: T0,
      },
      {
        relationship_id: "rel-other-agent",
        agent_id: AGENT_B,
        from_entity_id: "ent-s",
        to_entity_id: "ent-other",
        updated_at: T0,
      },
    );

    vi.setSystemTime(new Date(T2));
    const merged = await store.merge("ent-t", [
      "ent-t",
      "ent-missing",
      "ent-s",
    ]);

    expect(merged.entityId).toBe("ent-t");
    expect(merged.tags).toEqual(["alpha", "beta", "keep"]);
    expect(merged.identities.map((row) => row.handle).sort()).toEqual([
      "@t",
      "s@x.com",
    ]);
    expect(merged.attributes?.role).toMatchObject({
      value: "source",
      confidence: 0.9,
    });
    expect(merged.attributes?.city?.value).toBe("sf");
    expect(merged.state.lastObservedAt).toBe(T1);
    expect(merged.state.lastInboundAt).toBe(T0);
    expect(merged.state.lastOutboundAt).toBe(T1);

    await expect(store.get("ent-s")).resolves.toBeNull();
    expect(kg.identities.some((row) => row.entity_id === "ent-s")).toBe(false);
    expect(kg.attributes.some((row) => row.entity_id === "ent-s")).toBe(false);
    expect(kg.relationships).toEqual([
      {
        relationship_id: "rel-from",
        agent_id: AGENT_A,
        from_entity_id: "ent-t",
        to_entity_id: "ent-other",
        updated_at: T2,
      },
      {
        relationship_id: "rel-to",
        agent_id: AGENT_A,
        from_entity_id: "ent-other",
        to_entity_id: "ent-t",
        updated_at: T2,
      },
      {
        relationship_id: "rel-other-agent",
        agent_id: AGENT_B,
        from_entity_id: "ent-s",
        to_entity_id: "ent-other",
        updated_at: T0,
      },
    ]);
  });

  it("refuses to delete the self entity and no-ops delete of a missing id", async () => {
    const { store } = createHarness();
    await store.ensureSelf();
    await expect(store.deleteForTest(SELF_ENTITY_ID)).rejects.toThrow(
      "[EntityStore] cannot delete self entity",
    );
    await expect(store.get(SELF_ENTITY_ID)).resolves.not.toBeNull();
    await expect(store.deleteForTest("missing")).resolves.toBeUndefined();
  });

  it("deleteForTest removes identities, attributes, and the entity row", async () => {
    const { store, kg } = createHarness();
    await store.upsert({
      entityId: "ent-alice",
      type: "person",
      preferredName: "Alice",
      identities: [identity({ platform: "slack", handle: "@alice" })],
      attributes: { role: attribute() },
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    await store.deleteForTest("ent-alice");
    await expect(store.get("ent-alice")).resolves.toBeNull();
    expect(kg.identities).toEqual([]);
    expect(kg.attributes).toEqual([]);
    expect(kg.entities).toEqual([]);
  });
});
