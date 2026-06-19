/**
 * InboxService unit tests.
 *
 * Exercises the triage back-end end to end with a fake runtime DB and a stubbed
 * classifier model: triage classifies each inbound message and persists a
 * triage entry; search/list read the persisted queue back. The classifier
 * itself (LLM JSON parsing) is covered by the model stub returning the
 * structured `{results:[...]}` shape it expects.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { InboxService } from "../src/inbox/service.ts";
import type { InboundMessage } from "../src/inbox/types.ts";

interface DbState {
  inserted: string[];
  triageRows: Record<string, unknown>[];
  exampleRows: Record<string, unknown>[];
  bySourceMessageId: Set<string>;
}

function makeRuntime(opts: {
  modelResponse: string;
  db?: Partial<DbState>;
}): { runtime: IAgentRuntime; db: DbState; useModel: ReturnType<typeof vi.fn> } {
  const db: DbState = {
    inserted: [],
    triageRows: opts.db?.triageRows ?? [],
    exampleRows: opts.db?.exampleRows ?? [],
    bySourceMessageId: opts.db?.bySourceMessageId ?? new Set(),
  };
  const useModel = vi.fn(async () => opts.modelResponse);
  const runtime = {
    agentId: "22222222-2222-2222-2222-222222222222" as UUID,
    character: { name: "Eliza" },
    useModel,
    adapter: {
      db: {
        execute: async (query: {
          queryChunks: Array<{ value?: unknown }>;
        }) => {
          const chunk = query.queryChunks[0]?.value;
          const sql = Array.isArray(chunk) ? String(chunk[0]) : String(chunk);
          if (sql.startsWith("INSERT INTO")) {
            db.inserted.push(sql);
            return [];
          }
          if (sql.includes("life_inbox_triage_examples")) {
            return db.exampleRows;
          }
          if (sql.includes("WHERE source_message_id =")) {
            // getBySourceMessageId: return a full row only when seeded as
            // existing (the repository parses it into a TriageEntry).
            const match = sql.match(/source_message_id = '([^']+)'/);
            const id = match?.[1];
            return id && db.bySourceMessageId.has(id)
              ? [triageRow({ id: "existing", source_message_id: id })]
              : [];
          }
          if (sql.includes("life_inbox_triage_entries")) {
            return db.triageRows;
          }
          return [];
        },
      },
    },
  } as unknown as IAgentRuntime;
  return { runtime, db, useModel };
}

function inbound(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    id: "msg-1",
    source: "gmail",
    senderName: "Alice",
    channelName: "Email from Alice",
    channelType: "dm",
    text: "Can you confirm the launch date?",
    snippet: "Can you confirm the launch date?",
    timestamp: Date.parse("2026-06-17T09:00:00.000Z"),
    ...overrides,
  };
}

function triageRow(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "r1",
    agent_id: "22222222-2222-2222-2222-222222222222",
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
    suggested_response: null,
    draft_response: null,
    auto_replied: false,
    resolved: false,
    resolved_at: null,
    created_at: "2026-06-17T10:00:00.000Z",
    updated_at: "2026-06-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("InboxService.triage", () => {
  it("classifies each message and persists a triage entry", async () => {
    const modelResponse = JSON.stringify({
      results: [
        {
          classification: "needs_reply",
          urgency: "high",
          confidence: 0.92,
          reasoning: "asks a direct question",
          suggestedResponse: "Yes, the launch is Friday.",
        },
      ],
    });
    const { runtime, db, useModel } = makeRuntime({ modelResponse });
    const service = new InboxService(runtime);

    const result = await service.triage([inbound({})]);

    expect(useModel).toHaveBeenCalledTimes(1);
    expect(result.triaged).toHaveLength(1);
    const triaged = result.triaged[0]!;
    expect(triaged.classification).toBe("needs_reply");
    expect(triaged.urgency).toBe("high");
    expect(triaged.confidence).toBeCloseTo(0.92);
    expect(triaged.suggestedResponse).toBe("Yes, the launch is Friday.");
    // Persisted exactly one triage entry into the app_lifeops table.
    expect(
      db.inserted.filter((s) =>
        s.includes("INSERT INTO app_inbox.life_inbox_triage_entries"),
      ),
    ).toHaveLength(1);
    expect(triaged.entry?.classification).toBe("needs_reply");
  });

  it("classifyOnly returns the decision without persisting", async () => {
    const modelResponse = JSON.stringify({
      results: [
        {
          classification: "ignore",
          urgency: "low",
          confidence: 0.4,
          reasoning: "automated newsletter",
        },
      ],
    });
    const { runtime, db } = makeRuntime({ modelResponse });
    const service = new InboxService(runtime);

    const result = await service.triage([inbound({})], { classifyOnly: true });

    expect(result.triaged[0]?.classification).toBe("ignore");
    expect(result.triaged[0]?.entry).toBeUndefined();
    expect(db.inserted).toHaveLength(0);
  });

  it("does not double-store a message already triaged by source id", async () => {
    const modelResponse = JSON.stringify({
      results: [
        {
          classification: "notify",
          urgency: "medium",
          confidence: 0.7,
          reasoning: "fyi",
        },
      ],
    });
    const { runtime, db } = makeRuntime({
      modelResponse,
      db: {
        bySourceMessageId: new Set(["msg-1"]),
        triageRows: [triageRow({ source_message_id: "msg-1" })],
      },
    });
    const service = new InboxService(runtime);

    const result = await service.triage([inbound({ id: "msg-1" })]);

    expect(result.triaged).toHaveLength(1);
    // It found the existing row, so it did not INSERT a new entry.
    expect(db.inserted).toHaveLength(0);
    expect(result.triaged[0]?.entry).toBeDefined();
  });

  it("returns empty for an empty batch without calling the model", async () => {
    const { runtime, useModel } = makeRuntime({ modelResponse: "[]" });
    const service = new InboxService(runtime);
    const result = await service.triage([]);
    expect(result.triaged).toHaveLength(0);
    expect(useModel).not.toHaveBeenCalled();
  });
});

describe("InboxService.search / list", () => {
  it("list returns the unresolved queue", async () => {
    const { runtime } = makeRuntime({
      modelResponse: "[]",
      db: {
        triageRows: [
          triageRow({ id: "r1", urgency: "high" }),
          triageRow({ id: "r2", urgency: "low", classification: "info" }),
        ],
      },
    });
    const service = new InboxService(runtime);
    const rows = await service.list(10);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.urgency).toBe("high");
  });

  it("search filters by classification when provided", async () => {
    const calls: string[] = [];
    const base = makeRuntime({
      modelResponse: "[]",
      db: { triageRows: [triageRow({ classification: "urgent" })] },
    });
    // Wrap execute to capture SQL.
    const originalDb = (
      base.runtime as unknown as {
        adapter: { db: { execute: (q: unknown) => Promise<unknown> } };
      }
    ).adapter.db;
    const wrapped = {
      execute: async (query: { queryChunks: Array<{ value?: unknown }> }) => {
        const chunk = query.queryChunks[0]?.value;
        const sql = Array.isArray(chunk) ? String(chunk[0]) : String(chunk);
        calls.push(sql);
        return originalDb.execute(query);
      },
    };
    (
      base.runtime as unknown as {
        adapter: { db: { execute: (q: unknown) => Promise<unknown> } };
      }
    ).adapter.db = wrapped;

    const service = new InboxService(base.runtime);
    const rows = await service.search({ classification: "urgent", limit: 5 });
    expect(rows).toHaveLength(1);
    expect(calls.some((s) => s.includes("classification = 'urgent'"))).toBe(
      true,
    );
  });
});
