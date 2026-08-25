import { MemoryType } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  hasInterruptedDomainPurchase,
  INTERRUPTED_DOMAIN_PURCHASE_SOURCE,
  recordInterruptedDomainPurchase,
  removeInterruptedDomainPurchase,
} from "./domain-facts";

const SOURCE = INTERRUPTED_DOMAIN_PURCHASE_SOURCE;

function interruptedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "fact-1",
    entityId: "entity-1",
    agentId: "agent-1",
    roomId: "room-1",
    content: { text: "purchase interrupted", type: "fact" },
    metadata: {
      type: MemoryType.CUSTOM,
      source: SOURCE,
      appId: "app-1",
      domain: "example.com",
      ...overrides,
    },
  };
}

function makeRuntime(overrides: Record<string, unknown> = {}) {
  return {
    getMemories: vi.fn(async () => []),
    createMemory: vi.fn(async () => undefined),
    deleteMemory: vi.fn(async () => undefined),
    agentId: "agent-1",
    ...overrides,
  } as never;
}

const message = { entityId: "entity-1", roomId: "room-1" } as never;
const app = { id: "app-1", name: "My App" } as never;

describe("interrupted domain purchase durable fact", () => {
  it("reports false when no matching fact exists", async () => {
    const runtime = makeRuntime();
    await expect(
      hasInterruptedDomainPurchase(runtime, message, "app-1", "example.com"),
    ).resolves.toBe(false);
  });

  it("finds a matching fact by source, appId and domain", async () => {
    const runtime = makeRuntime({
      getMemories: vi.fn(async () => [interruptedRow()]),
    });
    await expect(
      hasInterruptedDomainPurchase(runtime, message, "app-1", "example.com"),
    ).resolves.toBe(true);
  });

  it("does not match a different app or domain", async () => {
    const runtime = makeRuntime({
      getMemories: vi.fn(async () => [interruptedRow()]),
    });
    await expect(
      hasInterruptedDomainPurchase(runtime, message, "app-1", "other.com"),
    ).resolves.toBe(false);
    await expect(
      hasInterruptedDomainPurchase(runtime, message, "app-2", "example.com"),
    ).resolves.toBe(false);
  });

  it("scopes the lookup to the sender entity and skips the read without one", async () => {
    const getMemories = vi.fn(async () => [interruptedRow()]);
    const runtime = makeRuntime({ getMemories });
    await expect(
      hasInterruptedDomainPurchase(
        runtime,
        { roomId: "room-1" } as never,
        "app-1",
        "example.com",
      ),
    ).resolves.toBe(false);
    expect(getMemories).not.toHaveBeenCalled();
  });

  it("fails soft when the memory read throws", async () => {
    const runtime = makeRuntime({
      getMemories: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(
      hasInterruptedDomainPurchase(runtime, message, "app-1", "example.com"),
    ).resolves.toBe(false);
  });

  it("records a durable fact tagged with the interrupted-purchase source", async () => {
    const createMemory = vi.fn(async () => undefined);
    const runtime = makeRuntime({ createMemory });
    const ok = await recordInterruptedDomainPurchase(
      runtime,
      message,
      app,
      "example.com",
    );
    expect(ok).toBe(true);
    const memory = createMemory.mock.calls[0][0] as {
      entityId: string;
      metadata: Record<string, unknown>;
    };
    expect(memory.entityId).toBe("entity-1");
    expect(memory.metadata.source).toBe(SOURCE);
    expect(memory.metadata.appId).toBe("app-1");
    expect(memory.metadata.domain).toBe("example.com");
    expect(memory.metadata.kind).toBe("durable");
    expect(createMemory).toHaveBeenCalledWith(expect.anything(), "facts", true);
  });

  it("is idempotent — never creates a duplicate when the fact already exists", async () => {
    const createMemory = vi.fn(async () => undefined);
    const runtime = makeRuntime({
      getMemories: vi.fn(async () => [interruptedRow()]),
      createMemory,
    });
    const ok = await recordInterruptedDomainPurchase(
      runtime,
      message,
      app,
      "example.com",
    );
    expect(ok).toBe(true);
    expect(createMemory).not.toHaveBeenCalled();
  });

  it("refuses to record without an entity id", async () => {
    const createMemory = vi.fn(async () => undefined);
    const runtime = makeRuntime({ createMemory });
    const ok = await recordInterruptedDomainPurchase(
      runtime,
      { roomId: "room-1" } as never,
      app,
      "example.com",
    );
    expect(ok).toBe(false);
    expect(createMemory).not.toHaveBeenCalled();
  });

  it("fails soft when recording throws", async () => {
    const runtime = makeRuntime({
      createMemory: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const ok = await recordInterruptedDomainPurchase(
      runtime,
      message,
      app,
      "example.com",
    );
    expect(ok).toBe(false);
  });

  it("removes the fact after a successful buy", async () => {
    const deleteMemory = vi.fn(async () => undefined);
    const runtime = makeRuntime({
      getMemories: vi.fn(async () => [interruptedRow()]),
      deleteMemory,
    });
    const ok = await removeInterruptedDomainPurchase(
      runtime,
      message,
      "app-1",
      "example.com",
    );
    expect(ok).toBe(true);
    expect(deleteMemory).toHaveBeenCalledWith("fact-1");
  });

  it("does not delete when no fact is on record", async () => {
    const deleteMemory = vi.fn(async () => undefined);
    const runtime = makeRuntime({ deleteMemory });
    const ok = await removeInterruptedDomainPurchase(
      runtime,
      message,
      "app-1",
      "example.com",
    );
    expect(ok).toBe(false);
    expect(deleteMemory).not.toHaveBeenCalled();
  });
});
