/**
 * Unit tests for memory route path encoding validation and error handling.
 * Deterministic: validates that malformed percent-escapes across memory routes
 * fail closed with 400 Bad Request per Error Policy J3.
 */
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
} {
  const json = vi.fn();
  const error = vi.fn();
  const runtime = {
    agentId: "11111111-1111-4111-8111-111111111111" as UUID,
    character: { name: "Eliza" },
    ensureConnection: vi.fn().mockResolvedValue(undefined),
    getMemoryById: vi.fn().mockResolvedValue(null),
    deleteMemory: vi.fn().mockResolvedValue(undefined),
  } as unknown as AgentRuntime;

  const ctx: MemoryRouteContext = {
    req: {} as never,
    res: {} as never,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    runtime,
    agentName: "Eliza",
    json,
    error,
    readJsonBody: vi.fn().mockResolvedValue({}),
  };

  return { ctx, json, error };
}

describe("handleMemoryRoutes path encoding validation", () => {
  it("rejects malformed percent-encoding on GET /api/memories/by-entity/:entityId with 400", async () => {
    const { ctx, error } = createMemoryContext(
      "GET",
      "/api/memories/by-entity/%",
    );

    const handled = await handleMemoryRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid entity identifier encoding.",
      400,
    );
  });

  it("rejects malformed percent-encoding on DELETE /api/memories/:id with 400", async () => {
    const { ctx, error } = createMemoryContext("DELETE", "/api/memories/%");

    const handled = await handleMemoryRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(ctx.res, "Invalid memory id.", 400);
  });

  it("rejects malformed percent-encoding on PATCH /api/memories/:id with 400", async () => {
    const { ctx, error } = createMemoryContext("PATCH", "/api/memories/%");

    const handled = await handleMemoryRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(ctx.res, "Invalid memory id.", 400);
  });
});
