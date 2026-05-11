import { describe, expect, it } from "vitest";
import {
  ConversationRegistry,
  conversationRegistry,
} from "./conversation-registry";

describe("ConversationRegistry.open", () => {
  it("returns the same handle for repeated opens of the same conversation", () => {
    const registry = new ConversationRegistry();
    const a = registry.open({
      conversationId: "room-1",
      modelId: "eliza-1-9b",
      parallel: 4,
    });
    const b = registry.open({
      conversationId: "room-1",
      modelId: "eliza-1-9b",
      parallel: 4,
    });
    expect(b).toBe(a);
    expect(registry.size()).toBe(1);
  });

  it("treats different model ids as distinct handles", () => {
    const registry = new ConversationRegistry();
    const a = registry.open({
      conversationId: "room-1",
      modelId: "model-a",
      parallel: 4,
    });
    const b = registry.open({
      conversationId: "room-1",
      modelId: "model-b",
      parallel: 4,
    });
    expect(b).not.toBe(a);
    expect(registry.size()).toBe(2);
  });

  it("requires non-empty conversationId and modelId", () => {
    const registry = new ConversationRegistry();
    expect(() => registry.open({ conversationId: "", modelId: "m" })).toThrow();
    expect(() => registry.open({ conversationId: "c", modelId: "" })).toThrow();
  });

  it("pins the handle to slot 0 when parallel <= 1", () => {
    const registry = new ConversationRegistry();
    const handle = registry.open({
      conversationId: "x",
      modelId: "m",
      parallel: 1,
    });
    expect(handle.slotId).toBe(0);
  });

  it("spreads concurrent opens across slots, lowest-loaded first", () => {
    const registry = new ConversationRegistry();
    const slots = new Set<number>();
    for (let i = 0; i < 4; i += 1) {
      const handle = registry.open({
        conversationId: `room-${i}`,
        modelId: "m",
        parallel: 4,
      });
      slots.add(handle.slotId);
    }
    expect(slots.size).toBe(4);
  });
});

describe("ConversationRegistry.close", () => {
  it("frees the slot and is idempotent", () => {
    const registry = new ConversationRegistry();
    const handle = registry.open({
      conversationId: "x",
      modelId: "m",
      parallel: 4,
    });
    expect(handle.closed).toBe(false);
    registry.close("x", "m");
    registry.close("x", "m"); // idempotent — must not throw
    expect(registry.get("x", "m")).toBeNull();
  });

  it("frees a slot for reuse on next open", () => {
    const registry = new ConversationRegistry();
    const a = registry.open({
      conversationId: "a",
      modelId: "m",
      parallel: 2,
    });
    const b = registry.open({
      conversationId: "b",
      modelId: "m",
      parallel: 2,
    });
    expect(a.slotId).not.toBe(b.slotId);
    registry.close("a", "m");
    const c = registry.open({
      conversationId: "c",
      modelId: "m",
      parallel: 2,
    });
    // c should land on the freed slot (a's slot)
    expect(c.slotId).toBe(a.slotId);
  });
});

describe("ConversationRegistry.get", () => {
  it("returns null for unknown or closed handles", () => {
    const registry = new ConversationRegistry();
    expect(registry.get("nope", "m")).toBeNull();
    registry.open({ conversationId: "x", modelId: "m", parallel: 4 });
    registry.close("x", "m");
    expect(registry.get("x", "m")).toBeNull();
  });
});

describe("ConversationRegistry.evictIdle", () => {
  it("drops handles whose ttl has elapsed", () => {
    const registry = new ConversationRegistry();
    registry.open({
      conversationId: "x",
      modelId: "m",
      parallel: 4,
      ttlMs: 1_000,
    });
    expect(registry.size()).toBe(1);
    const dropped = registry.evictIdle(Date.now() + 5_000);
    expect(dropped).toEqual(["x"]);
    expect(registry.size()).toBe(0);
  });

  it("keeps handles whose ttl has NOT elapsed", () => {
    const registry = new ConversationRegistry();
    registry.open({
      conversationId: "x",
      modelId: "m",
      parallel: 4,
      ttlMs: 60_000,
    });
    const dropped = registry.evictIdle(Date.now() + 10_000);
    expect(dropped).toEqual([]);
    expect(registry.size()).toBe(1);
  });
});

describe("ConversationRegistry.highWater", () => {
  it("tracks the largest concurrent open count", () => {
    const registry = new ConversationRegistry();
    expect(registry.highWater()).toBe(0);
    registry.open({ conversationId: "a", modelId: "m", parallel: 8 });
    registry.open({ conversationId: "b", modelId: "m", parallel: 8 });
    registry.open({ conversationId: "c", modelId: "m", parallel: 8 });
    expect(registry.highWater()).toBe(3);
    registry.close("a", "m");
    registry.close("b", "m");
    // High-water mark must NOT decrease — it's a max over the lifetime
    expect(registry.highWater()).toBe(3);
  });
});

describe("ConversationRegistry.__resetForTests", () => {
  it("drops every handle and resets the high-water mark", () => {
    const registry = new ConversationRegistry();
    registry.open({ conversationId: "a", modelId: "m", parallel: 4 });
    registry.open({ conversationId: "b", modelId: "m", parallel: 4 });
    expect(registry.size()).toBe(2);
    expect(registry.highWater()).toBe(2);
    registry.__resetForTests();
    expect(registry.size()).toBe(0);
    expect(registry.highWater()).toBe(0);
    // A slot freed by reset is reusable from slot 0 again.
    const handle = registry.open({
      conversationId: "c",
      modelId: "m",
      parallel: 4,
    });
    expect(handle.slotId).toBe(0);
  });

  it("isolates the module singleton across test files", () => {
    conversationRegistry.__resetForTests();
    conversationRegistry.open({ conversationId: "leak", modelId: "m" });
    expect(conversationRegistry.size()).toBe(1);
    conversationRegistry.__resetForTests();
    expect(conversationRegistry.size()).toBe(0);
  });
});
