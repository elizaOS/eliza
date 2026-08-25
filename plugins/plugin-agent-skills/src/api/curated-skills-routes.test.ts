/**
 * Unit tests for `handleCuratedSkillsRoutes`: curated skill discovery,
 * promotion, disabling, deletion, and source editing across active,
 * proposed, and disabled lifecycle buckets. Deterministic, temp-directory backed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCuratedSkillsRoutes } from "./curated-skills-routes.ts";

interface RouteContextMock {
  ctx: Parameters<typeof handleCuratedSkillsRoutes>[0];
  json: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  readJsonBody: ReturnType<typeof vi.fn>;
}

function createRouteContext(
  method: string,
  pathname: string,
  body?: Record<string, unknown> | null,
): RouteContextMock {
  const req = { method, url: pathname } as http.IncomingMessage;
  const res = {} as http.ServerResponse;
  const json = vi.fn();
  const error = vi.fn();
  const readJsonBody = vi.fn().mockResolvedValue(body ?? null);
  const readBody = vi.fn().mockResolvedValue(body ? JSON.stringify(body) : "");

  const ctx: Parameters<typeof handleCuratedSkillsRoutes>[0] = {
    req,
    res,
    method,
    pathname,
    url: new URL(`http://localhost${pathname}`),
    json,
    error,
    readJsonBody,
    readBody,
    state: {},
    decodePathComponent: (v) => decodeURIComponent(v),
  };

  return { ctx, json, error, readJsonBody };
}

describe("handleCuratedSkillsRoutes", () => {
  let testStateDir: string;
  const originalEnv = process.env.ELIZA_STATE_DIR;

  beforeEach(() => {
    testStateDir = join(
      tmpdir(),
      `eliza-curated-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    process.env.ELIZA_STATE_DIR = testStateDir;
    mkdirSync(join(testStateDir, "skills", "curated", "active"), {
      recursive: true,
    });
    mkdirSync(join(testStateDir, "skills", "curated", "proposed"), {
      recursive: true,
    });
    mkdirSync(join(testStateDir, "skills", "curated", "disabled"), {
      recursive: true,
    });
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.ELIZA_STATE_DIR = originalEnv;
    } else {
      delete process.env.ELIZA_STATE_DIR;
    }
  });

  it("ignores non-curated-skill paths and returns false", async () => {
    const { ctx } = createRouteContext("GET", "/api/skills/other");
    const handled = await handleCuratedSkillsRoutes(ctx);
    expect(handled).toBe(false);
  });

  describe("GET /api/skills/curated", () => {
    it("returns empty list and zero counts when no skills exist", async () => {
      const { ctx, json } = createRouteContext("GET", "/api/skills/curated");
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(json).toHaveBeenCalledWith(
        ctx.res,
        expect.objectContaining({
          ok: true,
          skills: [],
          counts: { active: 0, proposed: 0, disabled: 0 },
        }),
      );
    });

    it("lists and sorts skills across active, proposed, and disabled buckets", async () => {
      const activeDir = join(
        testStateDir,
        "skills",
        "curated",
        "active",
        "web-search",
      );
      const proposedDir = join(
        testStateDir,
        "skills",
        "curated",
        "proposed",
        "code-review",
      );
      const disabledDir = join(
        testStateDir,
        "skills",
        "curated",
        "disabled",
        "old-tool",
      );

      mkdirSync(activeDir, { recursive: true });
      mkdirSync(proposedDir, { recursive: true });
      mkdirSync(disabledDir, { recursive: true });

      writeFileSync(
        join(activeDir, "SKILL.md"),
        `---
name: web-search
description: Search the web
provenance:
  source: human
  createdAt: "2026-08-20T10:00:00.000Z"
  refinedCount: 2
  lastEvalScore: 0.95
---
# Web Search Skill
`,
      );

      writeFileSync(
        join(proposedDir, "SKILL.md"),
        `---
name: code-review
description: Automated code review
provenance:
  source: agent-generated
  derivedFromTrajectory: traj-123
  createdAt: "2026-08-25T12:00:00.000Z"
  refinedCount: 0
---
# Code Review
`,
      );

      writeFileSync(
        join(disabledDir, "SKILL.md"),
        `---
name: old-tool
description: Deprecated tool
---
# Old Tool
`,
      );

      const { ctx, json } = createRouteContext("GET", "/api/skills/curated");
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(json).toHaveBeenCalledWith(ctx.res, {
        ok: true,
        skills: [
          expect.objectContaining({
            name: "web-search",
            status: "active",
            source: "human",
            refinedCount: 2,
            lastEvalScore: 0.95,
          }),
          expect.objectContaining({
            name: "code-review",
            status: "proposed",
            source: "agent-generated",
            derivedFromTrajectory: "traj-123",
          }),
          expect.objectContaining({
            name: "old-tool",
            status: "disabled",
            source: "human",
          }),
        ],
        counts: { active: 1, proposed: 1, disabled: 1 },
      });
    });

    it("skips directories without a SKILL.md file or hidden entries", async () => {
      const emptyDir = join(
        testStateDir,
        "skills",
        "curated",
        "active",
        "empty-dir",
      );
      const hiddenDir = join(
        testStateDir,
        "skills",
        "curated",
        "active",
        ".hidden-dir",
      );
      mkdirSync(emptyDir, { recursive: true });
      mkdirSync(hiddenDir, { recursive: true });
      writeFileSync(join(hiddenDir, "SKILL.md"), "content");

      const { ctx, json } = createRouteContext("GET", "/api/skills/curated");
      await handleCuratedSkillsRoutes(ctx);

      expect(json).toHaveBeenCalledWith(
        ctx.res,
        expect.objectContaining({
          skills: [],
          counts: { active: 0, proposed: 0, disabled: 0 },
        }),
      );
    });
  });

  describe("POST /api/skills/curated/:name/promote", () => {
    it.each([
      "-invalid",
      "invalid-",
      "in--valid",
      "a".repeat(65),
    ])("rejects non-canonical skill name %s with 400 Bad Request", async (badName) => {
      const { ctx, error } = createRouteContext(
        "POST",
        `/api/skills/curated/${badName}/promote`,
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(ctx.res, "Invalid skill name", 400);
    });

    it("returns 404 when proposed skill directory does not exist", async () => {
      const { ctx, error } = createRouteContext(
        "POST",
        "/api/skills/curated/nonexistent/promote",
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        'Proposed skill "nonexistent" not found',
        404,
      );
    });

    it("returns 409 when target skill already exists in active", async () => {
      const proposedDir = join(
        testStateDir,
        "skills",
        "curated",
        "proposed",
        "my-skill",
      );
      const activeDir = join(
        testStateDir,
        "skills",
        "curated",
        "active",
        "my-skill",
      );
      mkdirSync(proposedDir, { recursive: true });
      mkdirSync(activeDir, { recursive: true });

      const { ctx, error } = createRouteContext(
        "POST",
        "/api/skills/curated/my-skill/promote",
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        'Active skill "my-skill" already exists',
        409,
      );
    });

    it("successfully promotes proposed skill to active", async () => {
      const proposedDir = join(
        testStateDir,
        "skills",
        "curated",
        "proposed",
        "my-skill",
      );
      const activeDir = join(
        testStateDir,
        "skills",
        "curated",
        "active",
        "my-skill",
      );
      mkdirSync(proposedDir, { recursive: true });
      writeFileSync(join(proposedDir, "SKILL.md"), "# Hello");

      const { ctx, json } = createRouteContext(
        "POST",
        "/api/skills/curated/my-skill/promote",
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(existsSync(proposedDir)).toBe(false);
      expect(existsSync(activeDir)).toBe(true);
      expect(readFileSync(join(activeDir, "SKILL.md"), "utf-8")).toBe(
        "# Hello",
      );
      expect(json).toHaveBeenCalledWith(ctx.res, {
        ok: true,
        name: "my-skill",
        path: activeDir,
      });
    });
  });

  describe("POST /api/skills/curated/:name/disable", () => {
    it("rejects non-canonical skill name with 400 Bad Request", async () => {
      const { ctx, error } = createRouteContext(
        "POST",
        "/api/skills/curated/-bad-name/disable",
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(ctx.res, "Invalid skill name", 400);
    });

    it("returns 404 when active skill does not exist", async () => {
      const { ctx, error } = createRouteContext(
        "POST",
        "/api/skills/curated/nonexistent/disable",
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        'Active curated skill "nonexistent" not found',
        404,
      );
    });

    it("returns 409 when disabled skill already exists", async () => {
      const activeDir = join(
        testStateDir,
        "skills",
        "curated",
        "active",
        "my-skill",
      );
      const disabledDir = join(
        testStateDir,
        "skills",
        "curated",
        "disabled",
        "my-skill",
      );
      mkdirSync(activeDir, { recursive: true });
      mkdirSync(disabledDir, { recursive: true });

      const { ctx, error } = createRouteContext(
        "POST",
        "/api/skills/curated/my-skill/disable",
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        'Disabled skill "my-skill" already exists',
        409,
      );
    });

    it("successfully disables active skill by moving to disabled directory", async () => {
      const activeDir = join(
        testStateDir,
        "skills",
        "curated",
        "active",
        "my-skill",
      );
      const disabledDir = join(
        testStateDir,
        "skills",
        "curated",
        "disabled",
        "my-skill",
      );
      mkdirSync(activeDir, { recursive: true });
      writeFileSync(join(activeDir, "SKILL.md"), "# Active Skill");

      const { ctx, json } = createRouteContext(
        "POST",
        "/api/skills/curated/my-skill/disable",
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(existsSync(activeDir)).toBe(false);
      expect(existsSync(disabledDir)).toBe(true);
      expect(readFileSync(join(disabledDir, "SKILL.md"), "utf-8")).toBe(
        "# Active Skill",
      );
      expect(json).toHaveBeenCalledWith(ctx.res, {
        ok: true,
        name: "my-skill",
        path: disabledDir,
      });
    });
  });

  describe("DELETE /api/skills/curated/:name", () => {
    it("rejects non-canonical skill name with 400 Bad Request", async () => {
      const { ctx, error } = createRouteContext(
        "DELETE",
        "/api/skills/curated/-bad-name",
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(ctx.res, "Invalid skill name", 400);
    });

    it("returns 404 when skill is not found in any curated bucket", async () => {
      const { ctx, error } = createRouteContext(
        "DELETE",
        "/api/skills/curated/nonexistent",
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        'Curated skill "nonexistent" not found',
        404,
      );
    });

    it.each(["active", "proposed", "disabled"] as const)(
      "successfully deletes skill from %s bucket",
      async (bucket) => {
        const skillDir = join(
          testStateDir,
          "skills",
          "curated",
          bucket,
          "target-skill",
        );
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, "SKILL.md"), "# Body");

        const { ctx, json } = createRouteContext(
          "DELETE",
          "/api/skills/curated/target-skill",
        );
        const handled = await handleCuratedSkillsRoutes(ctx);

        expect(handled).toBe(true);
        expect(existsSync(skillDir)).toBe(false);
        expect(json).toHaveBeenCalledWith(ctx.res, {
          ok: true,
          name: "target-skill",
          path: skillDir,
        });
      },
    );
  });

  describe("PUT /api/skills/curated/:name/source", () => {
    it("rejects non-canonical skill name with 400 Bad Request", async () => {
      const { ctx, error } = createRouteContext(
        "PUT",
        "/api/skills/curated/bad--name/source",
        { content: "new content" },
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(ctx.res, "Invalid skill name", 400);
    });

    it("returns 400 when body does not match PutCuratedSkillSourceRequestSchema", async () => {
      const { ctx, error } = createRouteContext(
        "PUT",
        "/api/skills/curated/valid-name/source",
        { wrongField: 123 },
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        expect.any(String),
        400,
      );
    });

    it("returns 404 when skill does not exist in active or proposed", async () => {
      const { ctx, error } = createRouteContext(
        "PUT",
        "/api/skills/curated/nonexistent/source",
        { content: "new content" },
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(error).toHaveBeenCalledWith(
        ctx.res,
        'Curated skill "nonexistent" not found',
        404,
      );
    });

    it("successfully updates SKILL.md content for active skill", async () => {
      const activeDir = join(
        testStateDir,
        "skills",
        "curated",
        "active",
        "my-skill",
      );
      mkdirSync(activeDir, { recursive: true });
      const skillFile = join(activeDir, "SKILL.md");
      writeFileSync(skillFile, "old content");

      const { ctx, json } = createRouteContext(
        "PUT",
        "/api/skills/curated/my-skill/source",
        { content: "updated content markdown" },
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(readFileSync(skillFile, "utf-8")).toBe(
        "updated content markdown",
      );
      expect(json).toHaveBeenCalledWith(ctx.res, {
        ok: true,
        name: "my-skill",
        path: skillFile,
      });
    });

    it("successfully updates SKILL.md content for proposed skill", async () => {
      const proposedDir = join(
        testStateDir,
        "skills",
        "curated",
        "proposed",
        "my-proposed",
      );
      mkdirSync(proposedDir, { recursive: true });
      const skillFile = join(proposedDir, "SKILL.md");
      writeFileSync(skillFile, "draft content");

      const { ctx, json } = createRouteContext(
        "PUT",
        "/api/skills/curated/my-proposed/source",
        { content: "refined draft markdown" },
      );
      const handled = await handleCuratedSkillsRoutes(ctx);

      expect(handled).toBe(true);
      expect(readFileSync(skillFile, "utf-8")).toBe(
        "refined draft markdown",
      );
      expect(json).toHaveBeenCalledWith(ctx.res, {
        ok: true,
        name: "my-proposed",
        path: skillFile,
      });
    });
  });
});
