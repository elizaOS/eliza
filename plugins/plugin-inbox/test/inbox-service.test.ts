/**
 * InboxService unit tests.
 *
 * Exercises the triage back-end end to end with a fake runtime DB and a
 * stubbed classifier model. The classification tests exercise the REAL
 * classifier contract, not an echo of the stub:
 *
 *  - the prompt actually sent to the model carries the email content,
 *    sender, channel, and the label whitelist instructions;
 *  - raw model output is PARSED and NORMALIZED (case/whitespace/string
 *    numbers) before anything downstream sees it;
 *  - malformed output — prose, out-of-vocabulary labels, pipe-echoed
 *    "a|b" labels, omitted messages, out-of-range confidence — fails
 *    CLOSED: `triage` rejects with `InboxTriageClassificationError` and
 *    persists nothing.
 *
 * Persistence, dedupe-by-source-id, classifyOnly, and the search/list reads
 * are covered against the fake DB.
 */

import type { IAgentRuntime, UUID } from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { InboxService } from "../src/inbox/service.ts";
import { InboxTriageClassificationError } from "../src/inbox/triage-classifier.ts";
import type { InboundMessage } from "../src/inbox/types.ts";

interface DbState {
  inserted: string[];
  triageRows: Record<string, unknown>[];
  exampleRows: Record<string, unknown>[];
  bySourceMessageId: Set<string>;
}

function makeRuntime(opts: { modelResponse: string; db?: Partial<DbState> }): {
  runtime: IAgentRuntime;
  db: DbState;
  useModel: ReturnType<typeof vi.fn>;
} {
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
    // No NotificationService registered — triage's best-effort home-attention
    // notify must be a clean no-op (it never blocks/affects persistence).
    getService: () => null,
    adapter: {
      db: {
        execute: async (query: { queryChunks: Array<{ value?: unknown }> }) => {
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

function triageRow(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
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
    snoozed_until: null,
    resolved: false,
    resolved_at: null,
    created_at: "2026-06-17T10:00:00.000Z",
    updated_at: "2026-06-17T10:00:00.000Z",
    ...overrides,
  };
}

describe("InboxService.triage — classifier contract", () => {
  it("sends the email content and the label whitelist to the model", async () => {
    const modelResponse = JSON.stringify({
      results: [
        {
          classification: "needs_reply",
          urgency: "high",
          confidence: 0.92,
          reasoning: "asks a direct question",
        },
      ],
    });
    const { runtime, useModel } = makeRuntime({ modelResponse });
    const service = new InboxService(runtime);

    await service.triage([
      inbound({
        text: "Can you confirm the launch date for Project Neptune?",
        senderName: "Alice Chen",
        channelName: "Email from Alice Chen",
        gmailIsImportant: true,
      }),
    ]);

    expect(useModel).toHaveBeenCalledTimes(1);
    const [modelType, args] = useModel.mock.calls[0] as [
      string,
      { prompt: string },
    ];
    expect(modelType).toBe(ModelType.TEXT_SMALL);
    // The classifier must show the model the actual message, not a summary
    // the test invented.
    expect(args.prompt).toContain(
      "Can you confirm the launch date for Project Neptune?",
    );
    expect(args.prompt).toContain("Alice Chen");
    expect(args.prompt).toContain("Email from Alice Chen");
    expect(args.prompt).toContain("Gmail-marked-important");
    // The label vocabulary is part of the prompt contract.
    for (const label of ["ignore", "info", "notify", "needs_reply", "urgent"]) {
      expect(args.prompt).toContain(label);
    }
  });

  it("normalizes raw model output (case, whitespace, string numbers) before persisting", async () => {
    // Deliberately messy-but-valid model output: the values the service
    // returns must be the PARSED/normalized forms, so an echo of this
    // response cannot satisfy the assertions.
    const modelResponse = JSON.stringify({
      results: [
        {
          classification: "  NEEDS_REPLY ",
          urgency: "High",
          confidence: "0.92",
          reasoning: "asks a direct question",
          suggestedResponse: "  Yes, the launch is Friday.  ",
        },
      ],
    });
    const { runtime, db } = makeRuntime({ modelResponse });
    const service = new InboxService(runtime);

    const result = await service.triage([inbound({})]);

    expect(result.triaged).toHaveLength(1);
    const [triaged] = result.triaged;
    if (!triaged) throw new Error("expected one triaged item");
    expect(triaged.classification).toBe("needs_reply");
    expect(triaged.urgency).toBe("high");
    expect(triaged.confidence).toBeCloseTo(0.92);
    expect(triaged.suggestedResponse).toBe("Yes, the launch is Friday.");
    // Persisted exactly one triage entry into the app_inbox table.
    expect(
      db.inserted.filter((s) =>
        s.includes("INSERT INTO app_inbox.life_inbox_triage_entries"),
      ),
    ).toHaveLength(1);
    expect(triaged.entry?.classification).toBe("needs_reply");
  });

  it('normalizes the literal string "null" suggestedResponse to absent', async () => {
    const modelResponse = JSON.stringify({
      results: [
        {
          classification: "notify",
          urgency: "low",
          confidence: 0.6,
          reasoning: "fyi",
          suggestedResponse: "null",
        },
      ],
    });
    const { runtime } = makeRuntime({ modelResponse });
    const service = new InboxService(runtime);
    const result = await service.triage([inbound({})], { classifyOnly: true });
    expect(result.triaged[0]?.suggestedResponse).toBeUndefined();
  });

  it("fails closed on prose output: rejects and persists nothing", async () => {
    const { runtime, db } = makeRuntime({
      modelResponse:
        "I think this message needs a reply because it asks a question.",
    });
    const service = new InboxService(runtime);

    await expect(service.triage([inbound({})])).rejects.toThrow(
      InboxTriageClassificationError,
    );
    expect(db.inserted).toHaveLength(0);
  });

  it("fails closed on an out-of-vocabulary label", async () => {
    const { runtime, db } = makeRuntime({
      modelResponse: JSON.stringify({
        results: [
          {
            classification: "important",
            urgency: "high",
            confidence: 0.9,
            reasoning: "made-up label",
          },
        ],
      }),
    });
    const service = new InboxService(runtime);

    await expect(service.triage([inbound({})])).rejects.toThrow(
      InboxTriageClassificationError,
    );
    expect(db.inserted).toHaveLength(0);
  });

  it('fails closed on a pipe-echoed label ("needs_reply|urgent")', async () => {
    // Small local models echo the `a|b|c` placeholder from the prompt; the
    // whitelist must reject the compound string rather than store it.
    const { runtime, db } = makeRuntime({
      modelResponse: JSON.stringify({
        results: [
          {
            classification: "needs_reply|urgent",
            urgency: "low|medium|high",
            confidence: 0.9,
            reasoning: "echoed the placeholder",
          },
        ],
      }),
    });
    const service = new InboxService(runtime);

    await expect(service.triage([inbound({})])).rejects.toThrow(
      InboxTriageClassificationError,
    );
    expect(db.inserted).toHaveLength(0);
  });

  it("fails closed when the model omits a message from the batch", async () => {
    const { runtime, db } = makeRuntime({
      modelResponse: JSON.stringify({
        results: [
          {
            classification: "ignore",
            urgency: "low",
            confidence: 0.5,
            reasoning: "only one result for two messages",
          },
        ],
      }),
    });
    const service = new InboxService(runtime);

    await expect(
      service.triage([
        inbound({ id: "msg-1" }),
        inbound({ id: "msg-2", text: "Second message" }),
      ]),
    ).rejects.toThrow(InboxTriageClassificationError);
    expect(db.inserted).toHaveLength(0);
  });

  it("fails closed on out-of-range confidence", async () => {
    const { runtime, db } = makeRuntime({
      modelResponse: JSON.stringify({
        results: [
          {
            classification: "urgent",
            urgency: "high",
            confidence: 1.7,
            reasoning: "confidence must be within [0, 1]",
          },
        ],
      }),
    });
    const service = new InboxService(runtime);

    await expect(service.triage([inbound({})])).rejects.toThrow(
      InboxTriageClassificationError,
    );
    expect(db.inserted).toHaveLength(0);
  });
});

describe("InboxService.triage — persistence", () => {
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
