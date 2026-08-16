/**
 * Exercises the standalone agent memory-feed cursor at its real route-handler
 * boundary with an in-memory runtime, including the valid zero timestamp.
 */

import type { AgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import type { MemoryRouteContext } from "./memory-routes.ts";
import { handleMemoryRoutes } from "./memory-routes.ts";

describe("GET /api/memories/feed cursor", () => {
  test("honors a before cursor at the Unix epoch", async () => {
    const response: { value?: unknown } = {};
    const runtime = {
      agentId: "11111111-1111-4111-8111-111111111111" as UUID,
      character: { name: "Eliza" },
      ensureConnection: vi.fn(async () => undefined),
      getMemories: vi.fn(async () => [
        {
          id: "22222222-2222-4222-8222-222222222222" as UUID,
          entityId: "33333333-3333-4333-8333-333333333333" as UUID,
          roomId: "44444444-4444-4444-8444-444444444444" as UUID,
          content: { text: "created after the cursor" },
          createdAt: 1,
        },
      ]),
    } as unknown as AgentRuntime;
    const context: MemoryRouteContext = {
      req: {} as never,
      res: {} as never,
      method: "GET",
      pathname: "/api/memories/feed",
      url: new URL(
        "https://agent.test/api/memories/feed?before=0&type=messages",
      ),
      runtime,
      agentName: "Eliza",
      json: (_res, value) => {
        response.value = value;
      },
      error: (_res, message, status) => {
        throw new Error(`unexpected ${status}: ${message}`);
      },
      readJsonBody: async <T extends object>() => ({}) as T,
    };

    expect(await handleMemoryRoutes(context)).toBe(true);
    expect(response.value).toEqual({
      memories: [],
      count: 0,
      limit: 50,
      hasMore: false,
    });
  });
});
