/** Verifies active reservations, expiry, replay, and scope isolation. */
import { describe, expect, it } from "vitest";
import { createChatIdempotencyStore } from "./chat-idempotency-service.ts";

describe("chat idempotency store", () => {
  it("reserves active turns and replays cloned settled outcomes", () => {
    const store = createChatIdempotencyStore<{ value: string }>({
      retentionMs: 10,
    });
    expect(store.reserve("room", "id", 1)).toBe(false);
    expect(store.reserve("room", "id", 2)).toBe(true);
    store.settle("room", "id", { value: "done" });
    const replay = store.outcome("room", "id");
    expect(replay).toEqual({ value: "done" });
    if (replay) replay.value = "mutated";
    expect(store.outcome("room", "id")).toEqual({ value: "done" });
  });

  it("isolates scopes and releases failed turns", () => {
    const store = createChatIdempotencyStore();
    expect(store.reserve("first", "id", 1)).toBe(false);
    expect(store.reserve("second", "id", 1)).toBe(false);
    store.release("first", "id");
    expect(store.reserve("first", "id", 2)).toBe(false);
  });
});
