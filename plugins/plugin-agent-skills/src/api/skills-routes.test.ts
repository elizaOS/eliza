/**
 * Unit tests for `handleSkillsRoutes` path encoding validation and error handling.
 * Deterministic: validates that malformed percent-escapes across skill and catalog
 * routes fail closed with 400 Bad Request per Error Policy J3 before touching
 * disk or internal services.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  handleSkillsRoutes,
  type SkillsRouteContext,
} from "./skills-routes";

function createSkillsContext(
  method: string,
  pathname: string,
  overrides: Partial<SkillsRouteContext> = {},
): {
  ctx: SkillsRouteContext;
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
} {
  const req = { method, url: pathname } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();

  const ctx: SkillsRouteContext = {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    state: {
      runtime: {
        getCache: vi.fn().mockResolvedValue({}),
        setCache: vi.fn().mockResolvedValue(undefined),
        getService: vi.fn().mockReturnValue(undefined),
      } as unknown as AgentRuntime,
      config: { agents: { defaults: { workspace: "/tmp/mock-workspace" } } },
      skills: [],
    },
    json,
    error,
    readJsonBody: vi.fn().mockResolvedValue({}),
    readBody: vi.fn().mockResolvedValue(""),
    discoverSkills: vi.fn().mockResolvedValue([]),
    ...overrides,
  };

  return { ctx, json, error };
}

describe("handleSkillsRoutes path encoding validation", () => {
  it("rejects malformed percent-encoding on GET /api/skills/catalog/:slug with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "GET",
      "/api/skills/catalog/%",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill slug encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on GET /api/skills/:id/scan with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "GET",
      "/api/skills/%/scan",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on POST /api/skills/:id/acknowledge with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "POST",
      "/api/skills/%/acknowledge",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on POST /api/skills/:id/open with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "POST",
      "/api/skills/%/open",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on GET /api/skills/:id/source with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "GET",
      "/api/skills/%/source",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on POST /api/skills/:id/enable with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "POST",
      "/api/skills/%/enable",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on POST /api/skills/:id/disable with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "POST",
      "/api/skills/%/disable",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on PUT /api/skills/:id/source with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "PUT",
      "/api/skills/%/source",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("rejects malformed percent-encoding on DELETE /api/skills/:id with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "DELETE",
      "/api/skills/%",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("decodes valid percent-encoded skill ID and performs lookup", async () => {
    const { ctx, error } = createSkillsContext(
      "GET",
      "/api/skills/valid%2Dskill/scan",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    // Not found in mock workspace / disk -> proceeds through normal logic without 400 encoding error
    expect(error).not.toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("rejects invalid skill ID characters after valid URL decoding with 400", async () => {
    const { ctx, error } = createSkillsContext(
      "GET",
      "/api/skills/skill%20with%20spaces/scan",
    );

    const handled = await handleSkillsRoutes(ctx);

    expect(handled).toBe(true);
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      expect.stringContaining("Invalid skill ID"),
      400,
    );
  });
});
