/**
 * Exercises the remember HTTP handler's stable-write contract with an
 * in-memory runtime boundary: a retried key returns the original memory and
 * never issues a second create.
 */

import { describe, expect, mock, test } from "bun:test";
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import type { MemoryRouteContext } from "./memory-routes.ts";
import { handleMemoryRoutes } from "./memory-routes.ts";

function contextFor(args: {
  body: Record<string, unknown>;
  memories: Map<UUID, Memory>;
  createMemory: ReturnType<typeof mock>;
  response: { value?: unknown };
}): MemoryRouteContext {
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111" as UUID,
    character: { name: "Eliza" },
    ensureConnection: mock(async () => undefined),
    getMemoryById: mock(async (id: UUID) => args.memories.get(id) ?? null),
    createMemory: args.createMemory,
  } as unknown as AgentRuntime;
  return {
    req: {} as never,
    res: {} as never,
    method: "POST",
    pathname: "/api/memory/remember",
    url: new URL("https://agent.test/api/memory/remember"),
    runtime,
    agentName: "Eliza",
    json: (_res, value) => {
      args.response.value = value;
    },
    error: (_res, message, status) => {
      throw new Error(`unexpected ${status}: ${message}`);
    },
    readJsonBody: async <T extends object>() => args.body as T,
  };
}

describe("POST /api/memory/remember idempotency", () => {
  test("replays one stable memory for a reused key", async () => {
    const memories = new Map<UUID, Memory>();
    const createMemory = mock(async (memory: Memory) => {
      if (!memory.id)
        throw new Error("remember handler produced a memory without an id");
      memories.set(memory.id, memory);
      return memory.id;
    });
    const firstResponse: { value?: unknown } = {};
    const first = contextFor({
      body: {
        text: "Onboarding transcript",
        idempotencyKey: "onboarding:session-1",
      },
      memories,
      createMemory,
      response: firstResponse,
    });
    expect(await handleMemoryRoutes(first)).toBe(true);
    expect(firstResponse.value).toEqual(
      expect.objectContaining({ ok: true, replayed: false }),
    );

    const secondResponse: { value?: unknown } = {};
    const second = contextFor({
      body: {
        text: "changed retry body",
        idempotencyKey: "onboarding:session-1",
      },
      memories,
      createMemory,
      response: secondResponse,
    });
    expect(await handleMemoryRoutes(second)).toBe(true);
    expect(secondResponse.value).toEqual(
      expect.objectContaining({
        ok: true,
        id: (firstResponse.value as { id: UUID }).id,
        text: "Onboarding transcript",
        replayed: true,
      }),
    );
    expect(createMemory).toHaveBeenCalledTimes(1);
  });
});
