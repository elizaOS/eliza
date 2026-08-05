/**
 * Pins the merge policy shared by Durable Object and Postgres history stores.
 * The deterministic cases model completion/cancel races and stale mirrors.
 */

import { describe, expect, test } from "bun:test";
import { mergeSharedRuntimeHistoryMessages } from "./shared-runtime-history-policy";

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
