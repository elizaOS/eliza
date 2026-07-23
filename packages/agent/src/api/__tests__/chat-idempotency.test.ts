/**
 * Unit coverage for the HTTP chat-path idempotency decision logic
 * (report 05, Finding 1 / W3.1). The client stamps a stable `clientMessageId`
 * on every chat send; a retried/double-submitted POST carries the same id and
 * must not start a second LLM turn.
 *
 * These tests pin the pure decision function (`isDuplicateChatMessage`) and the
 * key-normalizer (`normalizeClientMessageId`) — the safety-critical invariant is
 * that an ABSENT/invalid id is NEVER treated as a duplicate, so requests without
 * an idempotency key are completely unaffected.
 */

import {
  type AgentRuntime,
  ChannelType,
  createMessageMemory,
  stringToUuid,
} from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __getChatDedupeTtlMsForTests,
  __resetChatDedupeForTests,
  getChatMessageIdOutcome,
  isDuplicateChatMessage,
  normalizeClientMessageId,
  persistExactConversationMemory,
  setChatMessageIdOutcome,
} from "../chat-routes.ts";

const OLD_ARRIVAL_TTL_MS = 30_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const RECONNECT_WAIT_TIMEOUT_MS = 30_000;
const RECONNECT_SIGNAL_DEBOUNCE_MS = 400;
const TTL_MS = __getChatDedupeTtlMsForTests();
const SCOPE = "room-a";

afterEach(() => {
  __resetChatDedupeForTests();
});

describe("normalizeClientMessageId", () => {
  it("accepts a non-empty trimmed string", () => {
    expect(normalizeClientMessageId("abc123")).toBe("abc123");
    expect(normalizeClientMessageId("  spaced  ")).toBe("spaced");
  });

  it("rejects absent / non-string / empty values", () => {
    expect(normalizeClientMessageId(undefined)).toBeNull();
    expect(normalizeClientMessageId(null)).toBeNull();
    expect(normalizeClientMessageId("")).toBeNull();
    expect(normalizeClientMessageId("   ")).toBeNull();
    expect(normalizeClientMessageId(42)).toBeNull();
    expect(normalizeClientMessageId({ id: "x" })).toBeNull();
  });

  it("rejects an over-length key (>128 chars) as malformed/abusive", () => {
    expect(normalizeClientMessageId("x".repeat(128))).toBe("x".repeat(128));
    expect(normalizeClientMessageId("x".repeat(129))).toBeNull();
  });
});

describe("isDuplicateChatMessage", () => {
  it("never treats an absent idempotency key as a duplicate", () => {
    const now = 1_000_000;
    // Same null key, same scope, same instant — still not a duplicate, ever.
    expect(isDuplicateChatMessage(SCOPE, null, now)).toBe(false);
    expect(isDuplicateChatMessage(SCOPE, null, now)).toBe(false);
    expect(isDuplicateChatMessage(SCOPE, null, now + 1)).toBe(false);
  });

  it("treats a first sighting as new and a repeat within TTL as duplicate", () => {
    const now = 2_000_000;
    expect(isDuplicateChatMessage(SCOPE, "msg-1", now)).toBe(false);
    // Immediate replay and a replay near the TTL boundary are both duplicates.
    expect(isDuplicateChatMessage(SCOPE, "msg-1", now)).toBe(true);
    expect(isDuplicateChatMessage(SCOPE, "msg-1", now + TTL_MS)).toBe(true);
  });

  it("does not suppress a different idempotency key in the same scope", () => {
    const now = 3_000_000;
    expect(isDuplicateChatMessage(SCOPE, "msg-a", now)).toBe(false);
    expect(isDuplicateChatMessage(SCOPE, "msg-b", now)).toBe(false);
    // Each id is independently deduped.
    expect(isDuplicateChatMessage(SCOPE, "msg-a", now)).toBe(true);
    expect(isDuplicateChatMessage(SCOPE, "msg-b", now)).toBe(true);
  });

  it("replays only the durable outcome bound to the exact key", () => {
    const now = 3_250_000;
    expect(isDuplicateChatMessage(SCOPE, "turn-a", now)).toBe(false);
    expect(isDuplicateChatMessage(SCOPE, "turn-b", now + 1)).toBe(false);

    const outcome = {
      text: "reply b",
      agentName: "Eliza",
      messageId: stringToUuid("reply-b"),
      transcriptVisibility: "internal" as const,
      thought: "reasoning",
      usage: {
        promptTokens: 4,
        completionTokens: 2,
        totalTokens: 6,
        isEstimated: false,
        llmCalls: 1,
      },
      actionResults: [{ actionName: "VIEWS", success: true }],
      failureKind: "no_provider" as const,
      accountConnect: { providers: ["openai-codex" as const] },
      localInference: { status: "ready" },
    };
    setChatMessageIdOutcome(SCOPE, "turn-b", outcome);
    outcome.actionResults[0].success = false;
    expect(getChatMessageIdOutcome(SCOPE, "turn-a")).toBeNull();
    expect(getChatMessageIdOutcome(SCOPE, "turn-b")).toEqual({
      text: "reply b",
      agentName: "Eliza",
      messageId: stringToUuid("reply-b"),
      transcriptVisibility: "internal",
      thought: "reasoning",
      usage: {
        promptTokens: 4,
        completionTokens: 2,
        totalTokens: 6,
        isEstimated: false,
        llmCalls: 1,
      },
      actionResults: [{ actionName: "VIEWS", success: true }],
      failureKind: "no_provider",
      accountConnect: { providers: ["openai-codex"] },
      localInference: { status: "ready" },
    });

    setChatMessageIdOutcome(SCOPE, "unknown", {
      text: "must not attach",
      agentName: "Eliza",
    });
    expect(getChatMessageIdOutcome(SCOPE, "unknown")).toBeNull();
  });

  it("covers the long-turn reconnect retry window that exceeded the old 30s arrival TTL", () => {
    const now = 3_500_000;
    const retryAfterLongTurn =
      DEFAULT_GENERATION_TIMEOUT_MS +
      RECONNECT_WAIT_TIMEOUT_MS +
      RECONNECT_SIGNAL_DEBOUNCE_MS;

    expect(isDuplicateChatMessage(SCOPE, "msg-long-turn", now)).toBe(false);
    expect(retryAfterLongTurn).toBeGreaterThan(OLD_ARRIVAL_TTL_MS);
    expect(
      isDuplicateChatMessage(SCOPE, "msg-long-turn", now + retryAfterLongTurn),
    ).toBe(true);
  });

  it("does not suppress the same id once the TTL has elapsed", () => {
    const now = 4_000_000;
    expect(isDuplicateChatMessage(SCOPE, "msg-ttl", now)).toBe(false);
    // Just past the window the id is new again (legitimate re-send of the same
    // text minutes later must go through).
    expect(isDuplicateChatMessage(SCOPE, "msg-ttl", now + TTL_MS + 1)).toBe(
      false,
    );
    // ...and is then deduped within its own fresh window.
    expect(isDuplicateChatMessage(SCOPE, "msg-ttl", now + TTL_MS + 1)).toBe(
      true,
    );
  });

  it("scopes the key per conversation/user — same id in a different scope is new", () => {
    const now = 5_000_000;
    expect(isDuplicateChatMessage("room-x", "shared-id", now)).toBe(false);
    // Identical id, different scope → not a duplicate.
    expect(isDuplicateChatMessage("room-y", "shared-id", now)).toBe(false);
    // Each scope deduplicates independently.
    expect(isDuplicateChatMessage("room-x", "shared-id", now)).toBe(true);
    expect(isDuplicateChatMessage("room-y", "shared-id", now)).toBe(true);
  });

  it("evicts expired entries so the cache stays bounded", () => {
    const start = 6_000_000;
    // Seed an entry, then let the window pass and trigger the amortized sweep
    // with a fresh request; the original key must read as new again afterward.
    expect(isDuplicateChatMessage(SCOPE, "old", start)).toBe(false);
    // A later request past the sweep window evicts "old".
    expect(
      isDuplicateChatMessage(SCOPE, "trigger-sweep", start + TTL_MS + 1),
    ).toBe(false);
    // "old" is gone → new again, not a stale duplicate.
    expect(isDuplicateChatMessage(SCOPE, "old", start + TTL_MS + 2)).toBe(
      false,
    );
  });
});

describe("persistExactConversationMemory", () => {
  it("recognizes a committed row after the storage acknowledgement is lost", async () => {
    const memory = createMessageMemory({
      id: stringToUuid("ack-lost-memory"),
      entityId: stringToUuid("ack-lost-user"),
      agentId: stringToUuid("ack-lost-agent"),
      roomId: stringToUuid("ack-lost-room"),
      content: {
        text: "exact payload",
        source: "api",
        channelType: ChannelType.DM,
      },
    });
    let stored: typeof memory | undefined;
    const runtime = {
      getMemoriesByIds: vi.fn(async () => (stored ? [stored] : [])),
      createMemory: vi.fn(async () => {
        stored = memory;
        throw new Error("commit acknowledgement lost");
      }),
    } as unknown as AgentRuntime;

    await expect(
      persistExactConversationMemory(runtime, memory),
    ).resolves.toMatchObject({ id: memory.id, content: memory.content });
    expect(runtime.createMemory).toHaveBeenCalledTimes(1);
  });

  it("rejects an existing id whose stored ownership or content differs", async () => {
    const memory = createMessageMemory({
      id: stringToUuid("conflicting-memory"),
      entityId: stringToUuid("conflicting-user"),
      agentId: stringToUuid("conflicting-agent"),
      roomId: stringToUuid("conflicting-room"),
      content: { text: "expected", channelType: ChannelType.DM },
    });
    const runtime = {
      getMemoriesByIds: vi.fn(async () => [
        {
          ...memory,
          agentId: stringToUuid("different-agent"),
          content: { ...memory.content, text: "different" },
        },
      ]),
      createMemory: vi.fn(),
    } as unknown as AgentRuntime;

    await expect(
      persistExactConversationMemory(runtime, memory),
    ).rejects.toThrow("already bound to different content");
    expect(runtime.createMemory).not.toHaveBeenCalled();
  });
});
