/**
 * inboxTriage provider unit tests.
 *
 * Owner-gated provider that reads the triage queue (urgent + needs_reply +
 * recent auto-replies) from the InboxRepository and renders a compact markdown
 * digest. We mock `hasOwnerAccess` and the runtime DB.
 */

import type { IAgentRuntime, Memory, State, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/agent", () => ({
  hasOwnerAccess: mocks.hasOwnerAccess,
}));

import { inboxTriageProvider } from "../src/providers/inbox-triage.ts";

function triageRow(
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: "r1",
    agent_id: "33333333-3333-3333-3333-333333333333",
    source: "gmail",
    source_room_id: null,
    source_entity_id: null,
    source_message_id: "m1",
    channel_name: "Email from Carol",
    channel_type: "email",
    deep_link: "https://mail.google.com/x",
    classification: "urgent",
    urgency: "high",
    confidence: 0.95,
    snippet: "Need a decision before EOD please respond now",
    sender_name: "Carol",
    thread_context: null,
    triage_reasoning: "time sensitive",
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

function makeRuntime(rowsFor: (sql: string) => unknown): IAgentRuntime {
  return {
    agentId: "33333333-3333-3333-3333-333333333333" as UUID,
    adapter: {
      db: {
        execute: async (query: {
          queryChunks: Array<{ value?: unknown }>;
        }) => {
          const chunk = query.queryChunks[0]?.value;
          const sql = Array.isArray(chunk) ? String(chunk[0]) : String(chunk);
          return rowsFor(sql);
        },
      },
    },
  } as unknown as IAgentRuntime;
}

const message = { id: "msg" as UUID, entityId: "owner" as UUID } as Memory;
const state = {} as State;

describe("inboxTriage provider", () => {
  beforeEach(() => {
    mocks.hasOwnerAccess.mockReset().mockResolvedValue(true);
  });

  it("returns an empty result for non-owners", async () => {
    mocks.hasOwnerAccess.mockResolvedValueOnce(false);
    const runtime = makeRuntime(() => []);
    const result = await inboxTriageProvider.get(runtime, message, state);
    expect(result.text).toBe("");
    expect(result.values?.inboxUnresolved).toBe(0);
  });

  it("returns empty when there are no pending items", async () => {
    const runtime = makeRuntime(() => []);
    const result = await inboxTriageProvider.get(runtime, message, state);
    expect(result.text).toBe("");
    expect(result.values?.inboxUnresolved).toBe(0);
  });

  it("renders urgent + needs-reply items into the digest with counts", async () => {
    const runtime = makeRuntime((sql) => {
      if (sql.includes("classification = 'urgent'")) {
        return [triageRow({ classification: "urgent", urgency: "high" })];
      }
      if (sql.includes("classification = 'needs_reply'")) {
        return [
          triageRow({
            id: "r2",
            classification: "needs_reply",
            urgency: "medium",
            channel_name: "DM with Dave",
            sender_name: "Dave",
            snippet: "can you confirm tomorrow?",
          }),
        ];
      }
      return [];
    });

    const result = await inboxTriageProvider.get(runtime, message, state);

    expect(result.values?.inboxUnresolved).toBe(2);
    expect(result.values?.inboxUrgent).toBe(1);
    expect(result.values?.inboxNeedsReply).toBe(1);
    expect(result.text).toContain("# Inbox: 2 items pending");
    expect(result.text).toContain("## Urgent");
    expect(result.text).toContain("## Needs Reply");
    expect(result.text).toContain("Carol");
    expect(result.text).toContain("Dave");
    // Owner egress is a pass-through: the deep link is surfaced verbatim.
    expect(result.text).toContain("https://mail.google.com/x");
    const data = result.data as { urgentItems: unknown[] };
    expect(data.urgentItems).toHaveLength(1);
  });

  it("returns empty when the DB query throws (schema not yet migrated)", async () => {
    const runtime = makeRuntime(() => {
      throw new Error("relation does not exist");
    });
    const result = await inboxTriageProvider.get(runtime, message, state);
    expect(result.text).toBe("");
    expect(result.values?.inboxUnresolved).toBe(0);
  });
});
