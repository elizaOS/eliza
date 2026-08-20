/**
 * Exercises the standalone agent memory-feed cursor at its real route-handler
 * boundary with an in-memory runtime, including the valid zero timestamp.
 */

import type { AgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, test, vi } from "vitest";
import type { MemoryRouteContext } from "./memory-routes.ts";
import { handleMemoryRoutes, parseMemoryTableFilter } from "./memory-routes.ts";

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

  test.each([
    ["abc", "non-numeric text"],
    ["0x10", "hex form (Number coercion would read 16)"],
    ["1e3", "exponent form"],
    ["-5", "negative"],
    ["1.5", "fractional"],
    ["012", "non-canonical leading zero"],
    ["9007199254740993", "beyond Number.isSafeInteger"],
  ])(
    "400s the non-canonical before cursor %j instead of silently mis-filtering the feed",
    async (rawCursor) => {
      const getMemories = vi.fn(async () => []);
      const runtime = {
        agentId: "11111111-1111-4111-8111-111111111111" as UUID,
        character: { name: "Eliza" },
        ensureConnection: vi.fn(async () => undefined),
        getMemories,
      } as unknown as AgentRuntime;
      const errors: Array<{ message: string; status?: number }> = [];
      const url = new URL("https://agent.test/api/memories/feed?type=messages");
      url.searchParams.set("before", rawCursor);
      const context: MemoryRouteContext = {
        req: {} as never,
        res: {} as never,
        method: "GET",
        pathname: "/api/memories/feed",
        url,
        runtime,
        agentName: "Eliza",
        json: () => {
          throw new Error("unexpected 200");
        },
        error: (_res, message, status) => {
          errors.push({ message, status });
        },
        readJsonBody: async <T extends object>() => ({}) as T,
      };

      expect(await handleMemoryRoutes(context)).toBe(true);
      expect(errors).toEqual([
        {
          message: "before must be a Unix timestamp in milliseconds",
          status: 400,
        },
      ]);
      expect(getMemories).not.toHaveBeenCalled();
    },
  );

  test.each([
    ["", "empty"],
    [" ", "whitespace-only"],
  ])(
    "treats a blank before value (%j) as no cursor, not junk",
    async (rawCursor) => {
      // `?before=` templates naturally from clients interpolating an unset
      // variable, and whitespace trims to the same blank. Both previously
      // mis-coerced (whitespace became an epoch-0 cursor via Number(" ") === 0,
      // silently emptying the feed); both now mean "no cursor" — unlike
      // present junk, which 400s.
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
            content: { text: "still visible without a cursor" },
            createdAt: 1,
          },
        ]),
      } as unknown as AgentRuntime;
      const context: MemoryRouteContext = {
        req: {} as never,
        res: {} as never,
        method: "GET",
        pathname: "/api/memories/feed",
        url: (() => {
          const u = new URL(
            "https://agent.test/api/memories/feed?type=messages",
          );
          u.searchParams.set("before", rawCursor);
          return u;
        })(),
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
      expect((response.value as { count: number }).count).toBe(1);
    },
  );

  test("rejects an unknown type before scanning tables", async () => {
    const getMemories = vi.fn(async () => []);
    const runtime = {
      agentId: "11111111-1111-4111-8111-111111111111" as UUID,
      character: { name: "Eliza" },
      ensureConnection: vi.fn(async () => undefined),
      getMemories,
    } as unknown as AgentRuntime;
    const errors: Array<{ message: string; status?: number }> = [];
    const context: MemoryRouteContext = {
      req: {} as never,
      res: {} as never,
      method: "GET",
      pathname: "/api/memories/feed",
      url: new URL("https://agent.test/api/memories/feed?type=notes"),
      runtime,
      agentName: "Eliza",
      json: () => {
        throw new Error("unexpected 200");
      },
      error: (_res, message, status) => {
        errors.push({ message, status });
      },
      readJsonBody: async <T extends object>() => ({}) as T,
    };

    expect(await handleMemoryRoutes(context)).toBe(true);
    expect(errors).toEqual([
      {
        message: "type must be one of: messages, memories, facts, documents",
        status: 400,
      },
    ]);
    expect(getMemories).not.toHaveBeenCalled();
  });
});

describe("parseMemoryTableFilter", () => {
  test("omitted and empty keep the unfiltered all-tables scan", () => {
    expect(parseMemoryTableFilter(null)).toEqual({ ok: true });
    expect(parseMemoryTableFilter("")).toEqual({ ok: true });
  });

  test("accepts the viewer table identities", () => {
    expect(parseMemoryTableFilter("messages")).toEqual({
      ok: true,
      tables: ["messages"],
    });
    expect(parseMemoryTableFilter("FACTS")).toEqual({
      ok: true,
      tables: ["facts"],
    });
  });

  test("rejects unknown tokens instead of returning every table", () => {
    expect(parseMemoryTableFilter("notes").ok).toBe(false);
    expect(parseMemoryTableFilter("message").ok).toBe(false);
    expect(parseMemoryTableFilter("all").ok).toBe(false);
  });
});
