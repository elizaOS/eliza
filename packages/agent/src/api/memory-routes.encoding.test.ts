/**
 * Unit tests for memory route path encoding validation and error handling.
 * Deterministic: exercises the production route and shared decoder with a
 * response stand-in, proving malformed escapes and decoded non-UUIDs fail
 * closed before memory storage is touched.
 */
import type http from "node:http";
import type { AgentRuntime, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { MemoryRouteContext } from "./memory-routes.ts";
import { handleMemoryRoutes } from "./memory-routes.ts";

function createMemoryContext(
  method: string,
  pathname: string,
): {
  ctx: MemoryRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
  res: http.ServerResponse;
  runtime: AgentRuntime;
} {
  const json = vi.fn();
  const error = vi.fn();
  const end = vi.fn();
  const res = {
    setHeader: vi.fn(),
    end,
  } as unknown as http.ServerResponse;
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111" as UUID,
    character: { name: "Eliza" },
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    getMemoryById: vi.fn().mockResolvedValue(null),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRuntime;

  const ctx: MemoryRouteContext = {
    req: {} as never,
    res,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    runtime,
    agentName: "Eliza",
    json,
    error,
    readJsonBody: vi.fn().mockResolvedValue({}),
  };

  return { ctx, json, error, end, res, runtime };
}

describe("handleMemoryRoutes path encoding validation", () => {
  it("rejects malformed percent-encoding on GET /api/memories/by-entity/:entityId with 400", async () => {
    const { ctx, end, error, res } = createMemoryContext(
      "GET",
      "/api/memories/by-entity/%",
    );

    const handled = await handleMemoryRoutes(ctx);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({
        error: "Invalid entity identifier: malformed URL encoding",
      }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects malformed percent-encoding on DELETE /api/memories/:id with 400", async () => {
    const { ctx, end, error, res } = createMemoryContext(
      "DELETE",
      "/api/memories/%",
    );

    const handled = await handleMemoryRoutes(ctx);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ error: "Invalid memory id: malformed URL encoding" }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects malformed percent-encoding on PATCH /api/memories/:id with 400", async () => {
    const { ctx, end, error, res } = createMemoryContext(
      "PATCH",
      "/api/memories/%",
    );

    const handled = await handleMemoryRoutes(ctx);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(400);
    expect(end).toHaveBeenCalledWith(
      JSON.stringify({ error: "Invalid memory id: malformed URL encoding" }),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/api/memories/by-entity/not%2Da%2Duuid"],
    ["DELETE", "/api/memories/not%2Da%2Duuid"],
    ["PATCH", "/api/memories/not%2Da%2Duuid"],
  ])("rejects a decoded non-UUID on %s %s", async (method, pathname) => {
    const { ctx, error, runtime } = createMemoryContext(method, pathname);

    expect(await handleMemoryRoutes(ctx)).toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      method === "GET" ? "Invalid entity identifier." : "Invalid memory id.",
      400,
    );
    expect(runtime.getMemoryById).not.toHaveBeenCalled();
    expect(runtime.deleteMemory).not.toHaveBeenCalled();
  });
});
