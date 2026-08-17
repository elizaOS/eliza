/**
 * Unit tests for `handleSkillsRoutes` path encoding validation and error handling.
 * Deterministic: validates that malformed percent-escapes across skill and catalog
 * routes fail closed with 400 Bad Request per Error Policy J3 before touching
 * disk or internal services.
 */
import type http from "node:http";
import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { SKILL_NAME_MAX_LENGTH } from "../types";
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
  readJsonBody: ReturnType<typeof vi.fn>;
  discoverSkills: ReturnType<typeof vi.fn>;
} {
  const req = { method, url: pathname } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn().mockResolvedValue({});
  const discoverSkills = vi.fn().mockResolvedValue([]);
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
    readJsonBody,
    readBody: vi.fn().mockResolvedValue(""),
    discoverSkills,
    ...overrides,
  };

  return { ctx, json, error, readJsonBody, discoverSkills };
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
      "Invalid skill slug: malformed URL encoding",
      400,
    );
  });

  it.each([
    "%2F",
    "%5C",
    ".",
    "..",
    "%00",
    "%20",
    "%252F",
    "UPPER",
    "a".repeat(65),
  ])("rejects non-canonical decoded catalog slug %s", async (encodedSlug) => {
    const { ctx, error } = createSkillsContext(
      "GET",
      `/api/skills/catalog/${encodedSlug}`,
    );

    await expect(handleSkillsRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(ctx.res, "Invalid skill slug", 400);
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

  it.each([
    [
      "POST",
      `/api/skills/${"a".repeat(SKILL_NAME_MAX_LENGTH + 1)}/acknowledge`,
    ],
    [
      "PUT",
      `/api/skills/${"a".repeat(SKILL_NAME_MAX_LENGTH + 1)}/source`,
    ],
  ])("rejects overlong skill IDs before collaborators for %s %s", async (method, pathname) => {
    const { ctx, error, readJsonBody, discoverSkills } = createSkillsContext(method, pathname);

    await expect(handleSkillsRoutes(ctx)).resolves.toBe(true);

    expect(error).toHaveBeenCalledWith(ctx.res, expect.stringContaining("Invalid skill ID"), 400);
    expect(readJsonBody).not.toHaveBeenCalled();
    expect(discoverSkills).not.toHaveBeenCalled();
    expect(ctx.state.runtime?.getCache).not.toHaveBeenCalled();
    expect(ctx.state.runtime?.getService).not.toHaveBeenCalled();
  });

  it("accepts a skill ID at the canonical length limit", async () => {
    const skillId = "a".repeat(SKILL_NAME_MAX_LENGTH);
    const { ctx, error, readJsonBody } = createSkillsContext(
      "POST",
      `/api/skills/${skillId}/acknowledge`,
    );

    await expect(handleSkillsRoutes(ctx)).resolves.toBe(true);

    expect(readJsonBody).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalledWith(
      ctx.res,
      expect.stringContaining("Invalid skill ID"),
      400,
    );
  });

  it("ignores the deprecated decoder callback while preserving its input contract", async () => {
    const legacyDecoder = vi.fn(() => "rewritten-by-host");
    const { ctx, error } = createSkillsContext("GET", "/api/skills/%/scan", {
      decodePathComponent: legacyDecoder,
    });

    await expect(handleSkillsRoutes(ctx)).resolves.toBe(true);

    expect(legacyDecoder).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill ID: malformed URL encoding",
      400,
    );
  });

  it("rejects invalid catalog slug characters after valid URL decoding", async () => {
    const { ctx, error } = createSkillsContext(
      "GET",
      "/api/skills/catalog/skill%20with%20spaces",
    );

    expect(await handleSkillsRoutes(ctx)).toBe(true);

    expect(error).toHaveBeenCalledWith(
      ctx.res,
      "Invalid skill slug",
      400,
    );
  });
});
