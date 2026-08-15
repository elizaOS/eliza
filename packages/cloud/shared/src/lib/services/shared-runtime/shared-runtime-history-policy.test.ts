/**
 * Pins the merge policy shared by Durable Object and Postgres history stores.
 * The deterministic cases model completion/cancel races and stale mirrors.
 */

import { describe, expect, test } from "bun:test";
import {
  MAX_HISTORY_MESSAGES,
  mergeSharedRuntimeHistoryMessages,
  selectSharedRuntimeContext,
} from "./shared-runtime-history-policy";

describe("shared runtime history merge policy", () => {
  test("a late interrupted fragment cannot replace a completed assistant message", () => {
    const complete = {
      id: "assistant-1",
      role: "assistant" as const,
      content: "complete reply",
      createdAt: 2,
      interrupted: false,
    };

    expect(
      mergeSharedRuntimeHistoryMessages(
        [complete],
        [{ ...complete, content: "complete", interrupted: true }],
        40,
      ),
    ).toEqual([complete]);
  });

  test("the longest interrupted prefix wins until completion arrives", () => {
    const partial = {
      id: "assistant-1",
      role: "assistant" as const,
      content: "partial",
      createdAt: 2,
      interrupted: true,
    };
    const longer = { ...partial, content: "partial response" };
    const complete = { ...partial, content: "done", interrupted: false };

    expect(mergeSharedRuntimeHistoryMessages([partial], [longer], 40)).toEqual([longer]);
    expect(mergeSharedRuntimeHistoryMessages([longer], [complete], 40)).toEqual([complete]);
  });

  test("stale snapshots merge by id, reject invalid entries, and cap oldest turns", () => {
    const current = [
      { id: "one", role: "user" as const, content: "one", createdAt: 1 },
      { id: "two", role: "assistant" as const, content: "two", createdAt: 2 },
    ];
    const incoming = [
      current[0],
      { id: "three", role: "user" as const, content: "three", createdAt: 3 },
      { id: "invalid", role: "assistant" as const, content: "   ", createdAt: 4 },
    ];

    expect(mergeSharedRuntimeHistoryMessages(current, incoming, 2)).toEqual([
      current[1],
      incoming[1],
    ]);
  });
});

describe("shared runtime long-term transcript context", () => {
  test("keeps recent turns and recalls an older preference with its reply", () => {
    const history = Array.from({ length: 60 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content:
        index === 4
          ? "Remember that my favorite wine is Barolo"
          : index === 5
            ? "Got it, Barolo is your favorite wine."
            : `ordinary turn ${index}`,
      createdAt: index,
    }));

    const context = selectSharedRuntimeContext(
      history,
      "What was my favorite wine?",
      MAX_HISTORY_MESSAGES,
    );

    expect(context.length).toBeLessThanOrEqual(MAX_HISTORY_MESSAGES);
    expect(context.map((message) => message.id)).toContain("message-4");
    expect(context.map((message) => message.id)).toContain("message-5");
    expect(context.at(-1)?.id).toBe("message-59");
  });

  test("does not displace recent context for unrelated old chatter", () => {
    const history = Array.from({ length: 80 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `ordinary turn ${index}`,
      createdAt: index,
    }));

    const context = selectSharedRuntimeContext(history, "completely unrelated", 24);
    expect(context.map((message) => message.id)).toEqual(
      Array.from({ length: 24 }, (_, index) => `message-${index + 56}`),
    );
  });
});
