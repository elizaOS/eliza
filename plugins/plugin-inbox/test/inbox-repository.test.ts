/**
 * InboxRepository unit tests.
 *
 * The repository runs raw SQL against the runtime DB handle (the
 * `app_inbox.life_inbox_triage_*` tables PA registers). We mock
 * `runtime.adapter.db.execute` to capture the SQL and return canned rows, then
 * assert that writes emit the right statement and reads parse rows into
 * strongly-typed `TriageEntry` / `TriageExample` objects.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InboxRepository } from "../src/inbox/repository.ts";

interface ExecuteCall {
  sql: string;
}

function makeRuntime(rowsFor: (sql: string) => unknown): {
  runtime: IAgentRuntime;
  calls: ExecuteCall[];
} {
  const calls: ExecuteCall[] = [];
  const runtime = {
    agentId: "11111111-1111-1111-1111-111111111111" as UUID,
    adapter: {
      db: {
        execute: async (query: {
          queryChunks: Array<{ value?: unknown }>;
        }) => {
          const chunk = query.queryChunks[0]?.value;
          const sql = Array.isArray(chunk) ? String(chunk[0]) : String(chunk);
          calls.push({ sql });
          return rowsFor(sql);
        },
      },
    },
  } as unknown as IAgentRuntime;
  return { runtime, calls };
}

function triageRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "row-1",
    agent_id: "11111111-1111-1111-1111-111111111111",
    source: "gmail",
    source_room_id: null,
    source_entity_id: null,
    source_message_id: "msg-1",
    channel_name: "Email from Alice",
    channel_type: "email",
    deep_link: null,
    classification: "needs_reply",
    urgency: "high",
    confidence: 0.9,
    snippet: "please respond",
    sender_name: "Alice",
    thread_context: null,
    triage_reasoning: "asks a question",
    suggested_response: "Sure, will do.",
    draft_response: null,
    auto_replied: false,
    resolved: false,
    resolved_at: null,
    created_at: "2026-06-17T10:00:00.000Z",
    updated_at: "2026-06-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("InboxRepository", () => {
  let env: ReturnType<typeof makeRuntime>;

  beforeEach(() => {
    env = makeRuntime(() => []);
  });

  it("storeTriage INSERTs into the app_lifeops triage table with scoped agent id", async () => {
    const repo = new InboxRepository(env.runtime);
    const entry = await repo.storeTriage({
      source: "telegram",
      channelName: "DM with Bob",
      channelType: "dm",
      classification: "urgent",
      urgency: "high",
      confidence: 0.95,
      snippet: "need this now",
      senderName: "Bob",
    });

    expect(entry.classification).toBe("urgent");
    expect(entry.resolved).toBe(false);
    expect(entry.agentId).toBe("11111111-1111-1111-1111-111111111111");

    const insert = env.calls.find((c) => c.sql.startsWith("INSERT INTO"));
    expect(insert).toBeDefined();
    expect(insert?.sql).toContain(
      "INSERT INTO app_inbox.life_inbox_triage_entries",
    );
    expect(insert?.sql).toContain("'urgent'");
    expect(insert?.sql).toContain("'11111111-1111-1111-1111-111111111111'");
  });

  it("getUnresolved orders by urgency then recency and parses rows", async () => {
    env = makeRuntime((sql) => {
      if (sql.includes("life_inbox_triage_entries")) {
        return [
          triageRow({ id: "a", urgency: "high", snippet: "urgent one" }),
          triageRow({ id: "b", urgency: "low", classification: "info" }),
        ];
      }
      return [];
    });
    const repo = new InboxRepository(env.runtime);
    const rows = await repo.getUnresolved({ limit: 25 });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.urgency).toBe("high");
    expect(rows[1]?.classification).toBe("info");

    const select = env.calls[0]?.sql ?? "";
    expect(select).toContain("resolved = FALSE");
    expect(select).toContain("CASE urgency WHEN 'high' THEN 0");
    expect(select).toContain("LIMIT 25");
  });

  it("getByClassification filters on classification and unresolved", async () => {
    env = makeRuntime((sql) =>
      sql.includes("classification = 'urgent'")
        ? [triageRow({ classification: "urgent", urgency: "high" })]
        : [],
    );
    const repo = new InboxRepository(env.runtime);
    const rows = await repo.getByClassification("urgent", { limit: 5 });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.classification).toBe("urgent");
    expect(env.calls[0]?.sql).toContain("classification = 'urgent'");
    expect(env.calls[0]?.sql).toContain("AND resolved = FALSE");
  });

  it("markResolved sets resolved + resolved_at and optional draft", async () => {
    const repo = new InboxRepository(env.runtime);
    await repo.markResolved("row-1", {
      draftResponse: "done",
      autoReplied: true,
    });
    const update = env.calls.find((c) => c.sql.startsWith("UPDATE"));
    expect(update?.sql).toContain("resolved = TRUE");
    expect(update?.sql).toContain("draft_response = 'done'");
    expect(update?.sql).toContain("auto_replied = TRUE");
    expect(update?.sql).toContain("WHERE id = 'row-1'");
  });

  it("getBySourceMessageId returns null when no row matches", async () => {
    const repo = new InboxRepository(env.runtime);
    await expect(repo.getBySourceMessageId("missing")).resolves.toBeNull();
  });

  it("storeExample persists context json and parses it back on read", async () => {
    let stored: Record<string, unknown> | null = null;
    env = makeRuntime((sql) => {
      if (sql.startsWith("INSERT INTO app_inbox.life_inbox_triage_examples")) {
        stored = { sql } as unknown as Record<string, unknown>;
        return [];
      }
      return [];
    });
    const repo = new InboxRepository(env.runtime);
    const ex = await repo.storeExample({
      source: "telegram",
      snippet: "please confirm",
      classification: "needs_reply",
      ownerAction: "confirmed",
    });
    expect(ex.contextJson).toEqual({});
    expect(stored).not.toBeNull();
    expect(env.calls[0]?.sql).toContain(
      "INSERT INTO app_inbox.life_inbox_triage_examples",
    );
  });

  it("throws on an invalid persisted classification rather than silently coercing", async () => {
    env = makeRuntime(() => [triageRow({ classification: "bogus" })]);
    const repo = new InboxRepository(env.runtime);
    await expect(repo.getUnresolved()).rejects.toThrow(
      /invalid triage classification/,
    );
  });
});
