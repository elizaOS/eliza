/**
 * Behavioral tests for the REPLY_CONTEXT provider: renders nothing on non-reply
 * turns, identifies the replied-to message, dedupes the surrounding window
 * against RECENT_MESSAGES' complete transcript, and refuses a cross-room /
 * missing target. Deterministic — drives `replyContextProvider.get` against a
 * hand-built in-memory runtime of `vi.fn` stubs that answers its `getMemories`
 * queries from a single sorted message list; no live model or DB.
 */

import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeSingleLine,
  replyContextProvider,
  withWellFormedText,
} from "./replyContext.ts";

function isWellFormed(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const USER_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const OTHER_ROOM_ID = "00000000-0000-0000-0000-000000000009" as UUID;

// The provider guards `content.inReplyTo` through validateUuid, so message ids
// must be real UUIDs — a plain label like "m4" is rejected as a forged value.
function idFor(label: string): UUID {
  let hash = 0;
  for (let i = 0; i < label.length; i += 1) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  const hex = hash.toString(16).padStart(12, "0").slice(0, 12);
  return `00000000-0000-4000-8000-${hex}` as UUID;
}

function mem(
  label: string,
  entityId: UUID,
  text: string,
  createdAt: number,
  roomId: UUID = ROOM_ID,
): Memory {
  return {
    id: idFor(label),
    agentId: AGENT_ID,
    roomId,
    entityId,
    createdAt,
    content: { text, source: "discord" },
  } as Memory;
}

/**
 * Runtime whose `getMemories` answers the provider's three queries off ONE
 * sorted list, as the adapter does: the recent window (no start/end; every
 * row newest-first, or the newest `limit` rows when a limit is passed), the
 * older half (`end` + desc), and the newer half (`start` + asc). Real
 * filtering (bounds, order, limit) is applied so the dedupe + window assembly
 * is exercised for real.
 */
function makeRuntime(
  all: Memory[],
  target: Memory | null,
  conversationLength = 50,
): IAgentRuntime {
  const byId = new Map(all.map((m) => [m.id, m]));
  return {
    agentId: AGENT_ID,
    character: { name: "Agent" },
    getConversationLength: vi.fn(() => conversationLength),
    getMemoriesByIds: vi.fn(async (ids: UUID[]) =>
      ids.map((id) => byId.get(id)).filter((m): m is Memory => Boolean(m)),
    ),
    getMemories: vi.fn(
      async (params: {
        start?: number;
        end?: number;
        limit?: number;
        orderDirection?: "asc" | "desc";
      }) => {
        // Recent-window query: no bounds, newest-first.
        if (params.start === undefined && params.end === undefined) {
          const newestFirst = [...all].sort(
            (a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
          );
          return params.limit
            ? newestFirst.slice(0, params.limit)
            : newestFirst;
        }
        let rows = [...all];
        if (params.end !== undefined) {
          const end = params.end;
          rows = rows.filter((m) => (m.createdAt ?? 0) <= end);
        }
        if (params.start !== undefined) {
          const start = params.start;
          rows = rows.filter((m) => (m.createdAt ?? 0) >= start);
        }
        rows.sort((a, b) =>
          params.orderDirection === "asc"
            ? (a.createdAt ?? 0) - (b.createdAt ?? 0)
            : (b.createdAt ?? 0) - (a.createdAt ?? 0),
        );
        return params.limit ? rows.slice(0, params.limit) : rows;
      },
    ),
    getEntitiesForRoom: vi.fn(async () => [
      { id: AGENT_ID, agentId: AGENT_ID, names: ["Agent"], components: [] },
      { id: USER_ID, agentId: AGENT_ID, names: ["Alice"], components: [] },
    ]),
    getEntityById: vi.fn(async () => null),
    ...(target ? {} : {}),
  } as unknown as IAgentRuntime;
}

describe("replyContextProvider", () => {
  it("renders nothing when the incoming turn is not a reply", async () => {
    const incoming = mem("cur", USER_ID, "hi", 100);
    const result = await replyContextProvider.get(
      makeRuntime([], null),
      incoming,
      { values: {}, data: {}, text: "" },
    );
    expect(result.text).toBe("");
    expect(result.data?.replyTargetMessage).toBeNull();
  });

  it("identifies the replied-to message without repeating turns RECENT_MESSAGES shows", async () => {
    // A ten-turn room, longer than the runtime conversation length (3); the
    // reply targets an older turn (t=500). RECENT_MESSAGES renders every
    // retained row, so no surrounding turn may be repeated here.
    const thread = Array.from({ length: 10 }, (_, i) =>
      mem(
        `m${i}`,
        i % 2 === 0 ? USER_ID : AGENT_ID,
        `turn ${i}`,
        (i + 1) * 100,
      ),
    );
    const target = thread[4]; // t=500, "turn 4"
    const incoming = {
      ...mem("cur", USER_ID, "about that", 1100),
      content: { text: "about that", source: "discord", inReplyTo: target.id },
    } as Memory;
    const runtime = makeRuntime(thread, target, 3);

    const result = await replyContextProvider.get(runtime, incoming, {
      values: {},
      data: {},
      text: "",
    });

    // Identifies the target by sender + snippet.
    expect(result.text).toContain("direct reply to this earlier message");
    expect(result.text).toContain("turn 4");
    expect(result.text).not.toContain("Surrounding messages");
    expect(result.text).not.toContain("turn 0");
    expect(result.data?.replyContextMessages).toEqual([]);
    // The dedupe window is RECENT_MESSAGES' complete window, not the runtime
    // conversation length.
    expect(runtime.getMemories).toHaveBeenCalledWith(
      expect.not.objectContaining({ limit: expect.anything() }),
    );
  });

  it("ignores a reply id that resolves to another room", async () => {
    const foreign = mem("foreign", USER_ID, "secret", 500, OTHER_ROOM_ID);
    const incoming = {
      ...mem("cur", USER_ID, "leak?", 600),
      content: { text: "leak?", source: "discord", inReplyTo: foreign.id },
    } as Memory;

    const result = await replyContextProvider.get(
      makeRuntime([foreign], foreign),
      incoming,
      { values: {}, data: {}, text: "" },
    );

    expect(result.text).toBe("");
    expect(result.data?.replyTargetMessage).toBeNull();
  });

  it("renders nothing when the replied-to message no longer exists", async () => {
    const incoming = {
      ...mem("cur", USER_ID, "?", 100),
      content: {
        text: "?",
        source: "discord",
        inReplyTo: "00000000-0000-0000-0000-0000000000ff",
      },
    } as Memory;

    const result = await replyContextProvider.get(
      makeRuntime([], null),
      incoming,
      { values: {}, data: {}, text: "" },
    );

    expect(result.text).toBe("");
  });
});

describe("normalizeSingleLine", () => {
  it("preserves complete text while normalizing whitespace and Unicode", () => {
    const text = `  ${"a".repeat(2_000)}🦊  \n  tail\uD800  `;
    const out = normalizeSingleLine(text);
    expect(out).toBe(`${"a".repeat(2_000)}🦊 tail�`);
    expect(isWellFormed(out)).toBe(true);
  });
});

describe("withWellFormedText", () => {
  it("preserves long content and repairs lone surrogates", () => {
    const lone = `ok \uD800 ${"x".repeat(2_000)}`;
    const memory = mem("m4", USER_ID, lone, 400);
    const normalized = withWellFormedText(memory);
    expect(normalized.content.text).toBe(`ok � ${"x".repeat(2_000)}`);
    expect(isWellFormed(normalized.content.text as string)).toBe(true);
  });
});
