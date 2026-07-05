/**
 * Verifies the read-only parent-context bridge routes: the skills list/body
 * endpoints and the originatingTask read-back added for #13774.
 * Deterministic unit test with stubbed runtime + services; no live model.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { handleParentContextRoutes } from "../../src/api/parent-context-routes.ts";
import type { RouteContext } from "../../src/api/route-utils.ts";

function fakeRequest(opts: {
  method?: string;
  url: string;
  remoteAddress?: string;
}): IncomingMessage {
  const req = Readable.from([]) as unknown as IncomingMessage;
  (req as { method: string }).method = opts.method ?? "GET";
  (req as { url: string }).url = opts.url;
  (req as { socket: { remoteAddress: string } }).socket = {
    remoteAddress: opts.remoteAddress ?? "127.0.0.1",
  };
  (req as { headers: Record<string, string> }).headers = {
    host: "localhost:2138",
  };
  return req;
}

function fakeResponse(): {
  res: ServerResponse;
  status: () => number;
  body: () => unknown;
} {
  const writes: Buffer[] = [];
  let statusCode = 0;
  const res = {
    statusCode,
    headersSent: false,
    setHeader() {
      return res;
    },
    writeHead(code: number) {
      statusCode = code;
      res.statusCode = code;
      res.headersSent = true;
    },
    end(chunk?: Buffer | string) {
      if (chunk) writes.push(Buffer.from(chunk));
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => statusCode || res.statusCode,
    body: () => {
      const text = Buffer.concat(writes).toString("utf8");
      return text ? JSON.parse(text) : undefined;
    },
  };
}

type Skill = {
  slug: string;
  name: string;
  description: string;
  content: string;
};

function makeCtx(opts: {
  sessionMetadata?: Record<string, unknown>;
  skills?: Skill[];
  disabledSlugs?: Set<string>;
  task?: {
    goal: string;
    acceptanceCriteria?: string[];
    decisions?: Array<Record<string, unknown>>;
  } | null;
  noSkillsService?: boolean;
  noTaskService?: boolean;
}): RouteContext {
  const disabled = opts.disabledSlugs ?? new Set<string>();
  const skillsService = {
    getEligibleSkills: async () => opts.skills ?? [],
    isSkillEnabled: (slug: string) => !disabled.has(slug),
  };
  const taskService = {
    getTask: async (_id: string) => opts.task ?? null,
  };
  const runtime = {
    character: { name: "Eliza", bio: [], documents: [], knowledge: [] },
    getRoom: async () => null,
    getService: (name: string) => {
      if (name === "AGENT_SKILLS_SERVICE")
        return opts.noSkillsService ? null : skillsService;
      if (name === "ORCHESTRATOR_TASK_SERVICE")
        return opts.noTaskService ? null : taskService;
      return null;
    },
  } as unknown as RouteContext["runtime"];
  const acpService = {
    getSession: (id: string) => ({
      id,
      status: "running",
      workdir: "/tmp/work",
      metadata: opts.sessionMetadata ?? {},
    }),
  } as unknown as RouteContext["acpService"];
  return { runtime, acpService, workspaceService: null };
}

const SESSION = "pty-1-abc";

const SKILLS: Skill[] = [
  {
    slug: "eliza-cloud",
    name: "Eliza Cloud",
    description: "Cloud backend, billing, and monetization reference.",
    content: "# Eliza Cloud\n\nFull body: how to use Cloud.\n",
  },
  {
    slug: "github",
    name: "GitHub",
    description: "Create issues, PRs, and manage repos.",
    content: "# GitHub\n\nFull body: gh CLI usage.\n",
  },
];

async function call(url: string, ctx: RouteContext) {
  const req = fakeRequest({ url });
  const { res, status, body } = fakeResponse();
  const pathname = url.split("?")[0];
  const handled = await handleParentContextRoutes(req, res, pathname, ctx);
  return { handled, status: status(), body: body() };
}

describe("GET /api/coding-agents/<id>/skills", () => {
  it("lists enabled+eligible skills with full (untruncated) descriptions", async () => {
    const ctx = makeCtx({ skills: SKILLS });
    const { handled, status, body } = await call(
      `/api/coding-agents/${SESSION}/skills`,
      ctx,
    );
    expect(handled).toBe(true);
    expect(status).toBe(200);
    const skills = (body as { skills: Skill[] }).skills;
    expect(skills.map((s) => s.slug)).toEqual(["eliza-cloud", "github"]);
    // Full descriptions carried, no body/content leaked into the list.
    expect(skills[0].description).toBe(
      "Cloud backend, billing, and monetization reference.",
    );
    expect((skills[0] as Record<string, unknown>).body).toBeUndefined();
  });

  it("drops disabled skills from the list", async () => {
    const ctx = makeCtx({
      skills: SKILLS,
      disabledSlugs: new Set(["github"]),
    });
    const { body } = await call(`/api/coding-agents/${SESSION}/skills`, ctx);
    expect((body as { skills: Skill[] }).skills.map((s) => s.slug)).toEqual([
      "eliza-cloud",
    ]);
  });

  it("returns an empty list when the skills service is absent", async () => {
    const ctx = makeCtx({ noSkillsService: true });
    const { status, body } = await call(
      `/api/coding-agents/${SESSION}/skills`,
      ctx,
    );
    expect(status).toBe(200);
    expect((body as { skills: Skill[] }).skills).toEqual([]);
  });
});

describe("GET /api/coding-agents/<id>/skills/<slug>", () => {
  it("returns the full SKILL.md body for an enabled slug", async () => {
    const ctx = makeCtx({ skills: SKILLS });
    const { status, body } = await call(
      `/api/coding-agents/${SESSION}/skills/eliza-cloud`,
      ctx,
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      slug: "eliza-cloud",
      name: "Eliza Cloud",
      body: "# Eliza Cloud\n\nFull body: how to use Cloud.\n",
    });
  });

  it("404s an unknown slug", async () => {
    const ctx = makeCtx({ skills: SKILLS });
    const { status, body } = await call(
      `/api/coding-agents/${SESSION}/skills/does-not-exist`,
      ctx,
    );
    expect(status).toBe(404);
    expect((body as { code: string }).code).toBe("skill_not_found");
  });

  it("404s a disabled slug (present but not enabled)", async () => {
    const ctx = makeCtx({
      skills: SKILLS,
      disabledSlugs: new Set(["github"]),
    });
    const { status, body } = await call(
      `/api/coding-agents/${SESSION}/skills/github`,
      ctx,
    );
    expect(status).toBe(404);
    expect((body as { code: string }).code).toBe("skill_not_found");
  });
});

describe("parent-context originatingTask", () => {
  it("exposes the task goal + acceptance criteria + latest decisions", async () => {
    const decisions = Array.from({ length: 25 }, (_, i) => ({
      id: `d${i}`,
      sessionId: SESSION,
      event: "session_event",
      decision: `choice-${i}`,
      reasoning: `because ${i}`,
      response: null,
      timestamp: i,
      createdAt: new Date(i).toISOString(),
    }));
    const ctx = makeCtx({
      sessionMetadata: { taskId: "task-42" },
      task: {
        goal: "ship the monetized app",
        acceptanceCriteria: ["deploys", "charges work"],
        decisions,
      },
    });
    const { status, body } = await call(
      `/api/coding-agents/${SESSION}/parent-context`,
      ctx,
    );
    expect(status).toBe(200);
    const originating = (body as { originatingTask: Record<string, unknown> })
      .originatingTask;
    expect(originating.taskId).toBe("task-42");
    expect(originating.goal).toBe("ship the monetized app");
    expect(originating.acceptanceCriteria).toEqual(["deploys", "charges work"]);
    // Capped to the latest 20 decisions, newest last.
    const got = originating.decisions as Array<{ id: string }>;
    expect(got).toHaveLength(20);
    expect(got[0].id).toBe("d5");
    expect(got[19].id).toBe("d24");
  });

  it("is null when the session was not spawned from a task", async () => {
    const ctx = makeCtx({ sessionMetadata: {}, task: null });
    const { body } = await call(
      `/api/coding-agents/${SESSION}/parent-context`,
      ctx,
    );
    expect((body as { originatingTask: unknown }).originatingTask).toBeNull();
  });

  it("is null when the task store is absent", async () => {
    const ctx = makeCtx({
      sessionMetadata: { taskId: "task-42" },
      noTaskService: true,
    });
    const { body } = await call(
      `/api/coding-agents/${SESSION}/parent-context`,
      ctx,
    );
    expect((body as { originatingTask: unknown }).originatingTask).toBeNull();
  });
});

describe("bridge route gates still apply to skills", () => {
  it("rejects non-loopback callers", async () => {
    const ctx = makeCtx({ skills: SKILLS });
    const req = fakeRequest({
      url: `/api/coding-agents/${SESSION}/skills`,
      remoteAddress: "10.0.0.5",
    });
    const { res, status, body } = fakeResponse();
    await handleParentContextRoutes(
      req,
      res,
      `/api/coding-agents/${SESSION}/skills`,
      ctx,
    );
    expect(status()).toBe(403);
    expect((body() as { code: string }).code).toBe("loopback_only");
  });

  it("rejects a non-GET method", async () => {
    const ctx = makeCtx({ skills: SKILLS });
    const req = fakeRequest({
      method: "POST",
      url: `/api/coding-agents/${SESSION}/skills`,
    });
    const { res, status, body } = fakeResponse();
    await handleParentContextRoutes(
      req,
      res,
      `/api/coding-agents/${SESSION}/skills`,
      ctx,
    );
    expect(status()).toBe(405);
    expect((body() as { code: string }).code).toBe("method_not_allowed");
  });

  it("does not treat a stray sub-path on a leaf endpoint as handled", async () => {
    const ctx = makeCtx({});
    const { handled } = await call(
      `/api/coding-agents/${SESSION}/memory/extra`,
      ctx,
    );
    expect(handled).toBe(false);
  });
});
