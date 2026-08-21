/**
 * EscalationService keeps its in-memory state in module-level maps while the
 * cache key it persists under is agent-scoped. A process holding more than one
 * runtime — a multi-agent boot, or a runtime rebuilt in-process — must not let
 * one agent's escalation absorb another's: these tests pin per-agent isolation
 * of the active escalation, of the persisted cache row, and of resolution,
 * while keeping same-agent coalescing (the documented behaviour) intact.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, test } from "vitest";
import { EscalationService } from "./escalation.ts";

type CacheStore = Map<string, unknown>;

function makeRuntime(agentId: string, cache: CacheStore): IAgentRuntime {
  return {
    agentId,
    character: { name: `agent-${agentId}` },
    getRoomsForParticipant: async () => [],
    getRoom: async () => null,
    getWorld: async () => null,
    getService: () => null,
    getEntityById: async () => null,
    getMemoriesByRoomIds: async () => [],
    setCache: async (key: string, value: unknown) => {
      cache.set(key, value);
      return true;
    },
    getCache: async (key: string) => cache.get(key) ?? null,
    deleteCache: async (key: string) => {
      cache.delete(key);
      return true;
    },
    sendMessageToTarget: async () => {},
  } as unknown as IAgentRuntime;
}

const keyFor = (agentId: string) => `agent:escalation:active:${agentId}`;

describe("EscalationService per-agent isolation", () => {
  afterEach(() => {
    EscalationService._reset();
  });

  test("a second agent gets its own escalation instead of coalescing into the first", async () => {
    const cache: CacheStore = new Map();
    const runtimeA = makeRuntime("agent-a", cache);
    const runtimeB = makeRuntime("agent-b", cache);

    const first = await EscalationService.startEscalation(
      runtimeA,
      "reason A",
      "agent A private text",
    );
    const second = await EscalationService.startEscalation(
      runtimeB,
      "reason B",
      "agent B private text",
    );

    expect(second.id).not.toBe(first.id);
    expect(first.text).toBe("agent A private text");
    expect(first.reason).toBe("reason A");
    expect(second.text).toBe("agent B private text");
    expect(second.reason).toBe("reason B");
  });

  test("each agent's cache row holds that agent's own escalation", async () => {
    const cache: CacheStore = new Map();
    const runtimeA = makeRuntime("agent-a", cache);
    const runtimeB = makeRuntime("agent-b", cache);

    const first = await EscalationService.startEscalation(
      runtimeA,
      "reason A",
      "agent A private text",
    );
    const second = await EscalationService.startEscalation(
      runtimeB,
      "reason B",
      "agent B private text",
    );

    const storedA = cache.get(keyFor("agent-a")) as
      | { id: string; text: string }
      | undefined;
    const storedB = cache.get(keyFor("agent-b")) as
      | { id: string; text: string }
      | undefined;

    expect(storedA?.id).toBe(first.id);
    expect(storedA?.text).toBe("agent A private text");
    expect(storedB?.id).toBe(second.id);
    expect(storedB?.text).toBe("agent B private text");
  });

  test("getActiveEscalationSync only reports the calling agent's escalation", async () => {
    const cache: CacheStore = new Map();
    const runtimeA = makeRuntime("agent-a", cache);
    const runtimeB = makeRuntime("agent-b", cache);

    const first = await EscalationService.startEscalation(
      runtimeA,
      "reason A",
      "agent A private text",
    );

    expect(EscalationService.getActiveEscalationSync(runtimeA)?.id).toBe(
      first.id,
    );
    expect(EscalationService.getActiveEscalationSync(runtimeB)).toBeNull();
  });

  test("resolving one agent's escalation leaves the other's active", async () => {
    const cache: CacheStore = new Map();
    const runtimeA = makeRuntime("agent-a", cache);
    const runtimeB = makeRuntime("agent-b", cache);

    const first = await EscalationService.startEscalation(
      runtimeA,
      "reason A",
      "agent A private text",
    );
    const second = await EscalationService.startEscalation(
      runtimeB,
      "reason B",
      "agent B private text",
    );

    await EscalationService.resolveEscalation(first.id, runtimeA);

    expect(EscalationService.getActiveEscalationSync(runtimeA)).toBeNull();
    expect(EscalationService.getActiveEscalationSync(runtimeB)?.id).toBe(
      second.id,
    );
  });

  test("same-agent coalescing still folds a second reason into the active escalation", async () => {
    const cache: CacheStore = new Map();
    const runtime = makeRuntime("agent-a", cache);

    const first = await EscalationService.startEscalation(
      runtime,
      "reason 1",
      "first burst",
    );
    const second = await EscalationService.startEscalation(
      runtime,
      "reason 2",
      "second burst",
    );

    expect(second.id).toBe(first.id);
    expect(second.reason).toBe("reason 1; reason 2");
    expect(second.text).toContain("first burst");
    expect(second.text).toContain("second burst");
    expect(EscalationService.getActiveEscalationSync(runtime)?.id).toBe(
      first.id,
    );
  });
});
