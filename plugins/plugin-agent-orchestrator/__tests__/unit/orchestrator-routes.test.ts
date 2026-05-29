/**
 * HTTP contract for the `/api/orchestrator/*` handlers. The handlers are a thin
 * boundary over {@link OrchestratorTaskService} (covered separately), so this
 * test pins what the boundary itself owns: path/method dispatch and segment
 * parsing, input coercion (`asString`/`asStringArray`/`asPriority`/`parseLimit`)
 * and validation, and the HTTP status codes (201/400/404/503 and the 404
 * fallthrough for unmatched orchestrator paths).
 *
 * It drives {@link handleOrchestratorRoutes} with a readable-stream request and
 * a capturing response, backed by an in-memory store and a minimal ACP stub so
 * the add/stop-agent routes exercise the real service path.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { handleOrchestratorRoutes } from "../../src/api/orchestrator-routes.js";
import type { RouteContext } from "../../src/api/route-utils.js";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";

/** Minimal ACP stub: just enough for spawn/stop-agent routes to flow through
 * the real service without a live transport. */
const acpStub = {
  spawnSession: (opts: Record<string, unknown>) =>
    Promise.resolve({
      sessionId: "session-1",
      agentType: (opts.agentType as string | undefined) ?? "codex",
      workdir: (opts.workdir as string | undefined) ?? "/repo",
      status: "ready",
    }),
  stopSession: () => Promise.resolve(),
};

function makeService(): OrchestratorTaskService {
  return new OrchestratorTaskService(
    {
      getService: () => acpStub,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as never,
    { store: new OrchestratorTaskStore({ backend: "memory" }) },
  );
}

function ctxWith(service: OrchestratorTaskService | null): RouteContext {
  return {
    runtime: {
      getService: () => service,
      hasService: () => service !== null,
      getServiceLoadPromise: () => Promise.resolve(undefined),
    },
    acpService: null,
    workspaceService: null,
  } as never;
}

function makeReq(method: string, url: string, raw?: string): IncomingMessage {
  const stream = Readable.from(raw === undefined ? [] : [raw]);
  return Object.assign(stream, { method, url }) as unknown as IncomingMessage;
}

class CapturingResponse {
  statusCode = 0;
  body = "";
  writeHead(status: number): this {
    this.statusCode = status;
    return this;
  }
  end(chunk?: string): this {
    if (chunk !== undefined) this.body = chunk;
    return this;
  }
  json(): Record<string, unknown> {
    return this.body ? (JSON.parse(this.body) as Record<string, unknown>) : {};
  }
}

interface CallResult {
  matched: boolean;
  status: number;
  json: Record<string, unknown>;
}

async function call(
  service: OrchestratorTaskService | null,
  method: string,
  fullPath: string,
  body?: Record<string, unknown> | string,
): Promise<CallResult> {
  const pathname = fullPath.split("?")[0] ?? fullPath;
  const raw =
    body === undefined
      ? undefined
      : typeof body === "string"
        ? body
        : JSON.stringify(body);
  const req = makeReq(method, fullPath, raw);
  const res = new CapturingResponse();
  const matched = await handleOrchestratorRoutes(
    req,
    res as unknown as ServerResponse,
    pathname,
    ctxWith(service),
  );
  return { matched, status: res.statusCode, json: res.json() };
}

async function seedTask(
  service: OrchestratorTaskService,
  title = "Seeded",
): Promise<string> {
  const detail = await service.createTask({ title, goal: `${title} goal` });
  return detail.id;
}

describe("orchestrator routes — dispatch", () => {
  it("declines paths outside the orchestrator prefix", async () => {
    const result = await call(makeService(), "GET", "/api/other/thing");
    expect(result.matched).toBe(false);
  });

  it("returns 503 when the service is unavailable", async () => {
    const result = await call(null, "GET", "/api/orchestrator/status");
    expect(result.matched).toBe(true);
    expect(result.status).toBe(503);
  });

  it("404s an unmatched path under the orchestrator prefix", async () => {
    const result = await call(makeService(), "GET", "/api/orchestrator/nope");
    expect(result.status).toBe(404);
    expect(result.json.error).toBe("Orchestrator route not found");
  });

  it("serves aggregate status", async () => {
    const result = await call(makeService(), "GET", "/api/orchestrator/status");
    expect(result.status).toBe(200);
    expect(result.json.taskCount).toBe(0);
  });

  it("pauses and resumes all", async () => {
    const service = makeService();
    expect(
      (await call(service, "POST", "/api/orchestrator/pause-all")).json.paused,
    ).toBe(0);
    expect(
      (await call(service, "POST", "/api/orchestrator/resume-all")).json
        .resumed,
    ).toBe(0);
  });
});

describe("orchestrator routes — task CRUD", () => {
  it("creates a task, defaulting the goal to the title and dropping a bad priority", async () => {
    const result = await call(
      makeService(),
      "POST",
      "/api/orchestrator/tasks",
      {
        title: "Build it",
        priority: "bogus",
        acceptanceCriteria: ["ci green", "", 7],
      },
    );
    expect(result.status).toBe(201);
    expect(result.json.title).toBe("Build it");
    expect(result.json.goal).toBe("Build it");
    expect(result.json.priority).toBe("normal");
    expect(result.json.acceptanceCriteria).toEqual(["ci green"]);
  });

  it("rejects a task with no title", async () => {
    const result = await call(
      makeService(),
      "POST",
      "/api/orchestrator/tasks",
      {
        goal: "no title here",
      },
    );
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("title is required");
  });

  it("rejects a malformed JSON body", async () => {
    const result = await call(
      makeService(),
      "POST",
      "/api/orchestrator/tasks",
      "{not json",
    );
    expect(result.status).toBe(400);
    expect(result.json.error).toBe("Invalid JSON body");
  });

  it("lists tasks with status, archived, and limit filters", async () => {
    const service = makeService();
    const open = await seedTask(service, "open one");
    const done = await seedTask(service, "done one");
    await service.validateTask(done, { passed: true });

    const onlyDone = await call(
      service,
      "GET",
      "/api/orchestrator/tasks?status=done",
    );
    expect((onlyDone.json.tasks as { id: string }[]).map((t) => t.id)).toEqual([
      done,
    ]);

    await service.archiveTask(open);
    const visible = await call(service, "GET", "/api/orchestrator/tasks");
    expect((visible.json.tasks as unknown[]).length).toBe(1);
    const withArchived = await call(
      service,
      "GET",
      "/api/orchestrator/tasks?includeArchived=true",
    );
    expect((withArchived.json.tasks as unknown[]).length).toBe(2);
    const limited = await call(
      service,
      "GET",
      "/api/orchestrator/tasks?includeArchived=true&limit=1",
    );
    expect((limited.json.tasks as unknown[]).length).toBe(1);
  });

  it("gets, patches, and deletes a task; 404s a miss", async () => {
    const service = makeService();
    const id = await seedTask(service);

    expect(
      (await call(service, "GET", `/api/orchestrator/tasks/${id}`)).json.id,
    ).toBe(id);
    expect(
      (await call(service, "GET", "/api/orchestrator/tasks/missing")).status,
    ).toBe(404);

    const patched = await call(
      service,
      "PATCH",
      `/api/orchestrator/tasks/${id}`,
      { priority: "high", summary: "midway" },
    );
    expect(patched.json.priority).toBe("high");
    expect(patched.json.summary).toBe("midway");
    expect(
      (await call(service, "PATCH", "/api/orchestrator/tasks/missing", {}))
        .status,
    ).toBe(404);

    expect(
      (await call(service, "DELETE", `/api/orchestrator/tasks/${id}`)).json
        .deleted,
    ).toBe(true);
    expect(
      (await call(service, "DELETE", `/api/orchestrator/tasks/${id}`)).status,
    ).toBe(404);
  });
});

describe("orchestrator routes — lifecycle", () => {
  it("pauses, resumes, archives, and reopens", async () => {
    const service = makeService();
    const id = await seedTask(service);
    expect(
      (await call(service, "POST", `/api/orchestrator/tasks/${id}/pause`)).json
        .paused,
    ).toBe(true);
    expect(
      (await call(service, "POST", `/api/orchestrator/tasks/${id}/resume`)).json
        .paused,
    ).toBe(false);
    expect(
      (await call(service, "POST", `/api/orchestrator/tasks/${id}/archive`))
        .json.status,
    ).toBe("archived");
    expect(
      (await call(service, "POST", `/api/orchestrator/tasks/${id}/reopen`)).json
        .status,
    ).toBe("open");
    expect(
      (await call(service, "POST", "/api/orchestrator/tasks/missing/pause"))
        .status,
    ).toBe(404);
  });

  it("forks a task into a new linked thread", async () => {
    const service = makeService();
    const id = await seedTask(service, "Origin");
    const fork = await call(
      service,
      "POST",
      `/api/orchestrator/tasks/${id}/fork`,
      { title: "Origin (variant)" },
    );
    expect(fork.status).toBe(201);
    expect(fork.json.title).toBe("Origin (variant)");
    expect(fork.json.parentTaskId).toBe(id);
    expect(
      (await call(service, "POST", "/api/orchestrator/tasks/missing/fork", {}))
        .status,
    ).toBe(404);
  });

  it("requires a boolean `passed` to validate", async () => {
    const service = makeService();
    const id = await seedTask(service);
    expect(
      (
        await call(
          service,
          "POST",
          `/api/orchestrator/tasks/${id}/validate`,
          {},
        )
      ).status,
    ).toBe(400);
    const validated = await call(
      service,
      "POST",
      `/api/orchestrator/tasks/${id}/validate`,
      { passed: true, summary: "shipped" },
    );
    expect(validated.json.status).toBe("done");
    expect(validated.json.summary).toBe("shipped");
  });
});

describe("orchestrator routes — room, telemetry, agents", () => {
  it("lists and posts room messages", async () => {
    const service = makeService();
    const id = await seedTask(service);
    const page = await call(
      service,
      "GET",
      `/api/orchestrator/tasks/${id}/messages`,
    );
    expect(Array.isArray(page.json.items)).toBe(true);

    expect(
      (
        await call(
          service,
          "POST",
          `/api/orchestrator/tasks/${id}/messages`,
          {},
        )
      ).status,
    ).toBe(400);
    const posted = await call(
      service,
      "POST",
      `/api/orchestrator/tasks/${id}/messages`,
      { content: "steer left" },
    );
    expect(posted.status).toBe(201);
    expect(posted.json.recorded).toBe(true);
  });

  it("lists events and usage; 404s usage for a missing task", async () => {
    const service = makeService();
    const id = await seedTask(service);
    expect(
      (await call(service, "GET", `/api/orchestrator/tasks/${id}/events`))
        .status,
    ).toBe(200);
    expect(
      (await call(service, "GET", `/api/orchestrator/tasks/${id}/usage`))
        .status,
    ).toBe(200);
    expect(
      (await call(service, "GET", "/api/orchestrator/tasks/missing/usage"))
        .status,
    ).toBe(404);
  });

  it("adds a sub-agent and stops it by session id", async () => {
    const service = makeService();
    const id = await seedTask(service);
    const added = await call(
      service,
      "POST",
      `/api/orchestrator/tasks/${id}/agents`,
      { framework: "codex" },
    );
    expect(added.status).toBe(201);
    expect((added.json.sessions as unknown[]).length).toBe(1);

    const stopped = await call(
      service,
      "POST",
      `/api/orchestrator/tasks/${id}/agents/session-1/stop`,
    );
    expect(stopped.json.stopped).toBe(true);
    expect(
      (
        await call(
          service,
          "POST",
          `/api/orchestrator/tasks/${id}/agents/ghost/stop`,
        )
      ).status,
    ).toBe(404);
  });
});
