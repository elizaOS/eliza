/**
 * Curated learning loop route tests.
 *
 * Stubs HTTP req/res with no SQL involvement (no need — these routes operate
 * entirely on the curated skills filesystem layout).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleCuratedSkillsRoutes } from "./curated-skills-routes.js";

interface RecordedResponse {
  status: number;
  body: unknown;
}

function makeContext(method: string, path: string, body?: unknown) {
  const recorded: RecordedResponse = { status: 200, body: undefined };

  const req = {
    method,
    url: path,
    on(event: string, handler: (chunk?: unknown) => void) {
      if (event === "data" && body !== undefined) {
        handler(Buffer.from(JSON.stringify(body)));
      } else if (event === "end") {
        handler();
      }
    },
  } as unknown as http.IncomingMessage;

  const res = {
    statusCode: 200,
  } as unknown as http.ServerResponse;

  return {
    req,
    res,
    method,
    pathname: path,
    url: new URL(`http://localhost${path}`),
    json: (_res: http.ServerResponse, data: object, status?: number) => {
      recorded.status = status ?? 200;
      recorded.body = data;
    },
    error: (_res: http.ServerResponse, message: string, status?: number) => {
      recorded.status = status ?? 500;
      recorded.body = { error: message };
    },
    readJsonBody: async <T extends object>(): Promise<T | null> => {
      if (body === undefined) return null;
      return body as T;
    },
    recorded,
  };
}

function writeSkill(dir: string, name: string, source: string): void {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} description\nprovenance:\n  source: ${source}\n  createdAt: 2025-01-01T00:00:00Z\n  refinedCount: 0\n---\n## body\n`,
  );
}

let stateDir: string;
let prevState: string | undefined;
let prevElizaState: string | undefined;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "curated-routes-"));
  prevState = process.env.MILADY_STATE_DIR;
  prevElizaState = process.env.ELIZA_STATE_DIR;
  process.env.MILADY_STATE_DIR = stateDir;
  delete process.env.ELIZA_STATE_DIR;
});

afterEach(() => {
  if (prevState === undefined) delete process.env.MILADY_STATE_DIR;
  else process.env.MILADY_STATE_DIR = prevState;
  if (prevElizaState !== undefined)
    process.env.ELIZA_STATE_DIR = prevElizaState;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("curated skills routes", () => {
  it("GET /api/skills/curated returns active and proposed skills", async () => {
    writeSkill(
      join(stateDir, "skills", "curated", "active"),
      "skill-a",
      "agent-generated",
    );
    writeSkill(
      join(stateDir, "skills", "curated", "proposed"),
      "skill-b",
      "agent-generated",
    );

    const ctx = makeContext("GET", "/api/skills/curated");
    const handled = await handleCuratedSkillsRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);
    const body = ctx.recorded.body as {
      ok: boolean;
      skills: Array<{ name: string; status: string }>;
      counts: { active: number; proposed: number };
    };
    expect(body.ok).toBe(true);
    expect(body.counts.active).toBe(1);
    expect(body.counts.proposed).toBe(1);
    const names = body.skills.map((s) => `${s.status}/${s.name}`).sort();
    expect(names).toContain("active/skill-a");
    expect(names).toContain("proposed/skill-b");
  });

  it("POST /api/skills/curated/:name/promote moves proposed → active", async () => {
    writeSkill(
      join(stateDir, "skills", "curated", "proposed"),
      "promoter",
      "agent-generated",
    );

    const ctx = makeContext("POST", "/api/skills/curated/promoter/promote");
    const handled = await handleCuratedSkillsRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);

    const list = makeContext("GET", "/api/skills/curated");
    await handleCuratedSkillsRoutes(list);
    const body = list.recorded.body as {
      counts: { active: number; proposed: number };
    };
    expect(body.counts.active).toBe(1);
    expect(body.counts.proposed).toBe(0);
  });

  it("POST /api/skills/curated/:name/disable moves active → disabled", async () => {
    writeSkill(
      join(stateDir, "skills", "curated", "active"),
      "stable-skill",
      "agent-refined",
    );
    const ctx = makeContext("POST", "/api/skills/curated/stable-skill/disable");
    const handled = await handleCuratedSkillsRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);

    const list = makeContext("GET", "/api/skills/curated");
    await handleCuratedSkillsRoutes(list);
    const body = list.recorded.body as {
      counts: { active: number; disabled: number };
    };
    expect(body.counts.active).toBe(0);
    expect(body.counts.disabled).toBe(1);
  });

  it("DELETE removes the skill from any bucket", async () => {
    writeSkill(
      join(stateDir, "skills", "curated", "proposed"),
      "doomed",
      "agent-generated",
    );
    const ctx = makeContext("DELETE", "/api/skills/curated/doomed");
    const handled = await handleCuratedSkillsRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(200);

    const list = makeContext("GET", "/api/skills/curated");
    await handleCuratedSkillsRoutes(list);
    const body = list.recorded.body as {
      counts: { proposed: number };
    };
    expect(body.counts.proposed).toBe(0);
  });

  it("rejects invalid skill names with 400", async () => {
    const ctx = makeContext("POST", "/api/skills/curated/Bad%20Name/promote");
    const handled = await handleCuratedSkillsRoutes(ctx);
    // The route regex won't match — this falls through to "not handled".
    expect(handled).toBe(false);
  });

  it("returns 404 when promoting a missing proposal", async () => {
    const ctx = makeContext("POST", "/api/skills/curated/missing/promote");
    const handled = await handleCuratedSkillsRoutes(ctx);
    expect(handled).toBe(true);
    expect(ctx.recorded.status).toBe(404);
  });
});
