import type http from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleBackgroundTasksRoute } from "./background-tasks-routes";

function makeCtx(
  method: string,
  pathname: string,
  runtime: { getService: (serviceType: string) => unknown } | null,
) {
  const json = vi.fn();
  return {
    ctx: {
      req: {} as http.IncomingMessage,
      res: {} as http.ServerResponse,
      method,
      pathname,
      state: { runtime },
      json,
    },
    json,
  };
}

describe("handleBackgroundTasksRoute", () => {
  it("runs due tasks through the canonical task service", async () => {
    const runDueTasks = vi.fn().mockResolvedValue(undefined);
    const runtime = {
      getService: vi.fn(() => ({ runDueTasks })),
    };
    const { ctx, json } = makeCtx(
      "POST",
      "/api/background/run-due-tasks",
      runtime,
    );

    await expect(handleBackgroundTasksRoute(ctx)).resolves.toBe(true);

    expect(runtime.getService).toHaveBeenCalledWith("task");
    expect(runDueTasks).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith(
      ctx.res,
      expect.objectContaining({ ok: true, coalesced: false }),
    );
  });

  it("coalesces concurrent runs", async () => {
    let resolveRun: (() => void) | undefined;
    const runDueTasks = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const runtime = {
      getService: vi.fn(() => ({ runDueTasks })),
    };
    const first = makeCtx("POST", "/api/background/run-due-tasks", runtime);
    const second = makeCtx("POST", "/api/background/run-due-tasks", runtime);

    const firstPromise = handleBackgroundTasksRoute(first.ctx);
    const secondPromise = handleBackgroundTasksRoute(second.ctx);
    resolveRun?.();

    await expect(Promise.all([firstPromise, secondPromise])).resolves.toEqual([
      true,
      true,
    ]);
    expect(runDueTasks).toHaveBeenCalledOnce();
    expect(first.json).toHaveBeenCalledWith(
      first.ctx.res,
      expect.objectContaining({ ok: true, coalesced: false }),
    );
    expect(second.json).toHaveBeenCalledWith(
      second.ctx.res,
      expect.objectContaining({ ok: true, coalesced: true }),
    );
  });

  it("reports unavailable runtime or task service", async () => {
    const noRuntime = makeCtx("POST", "/api/background/run-due-tasks", null);
    await expect(handleBackgroundTasksRoute(noRuntime.ctx)).resolves.toBe(true);
    expect(noRuntime.json).toHaveBeenCalledWith(
      noRuntime.ctx.res,
      { ok: false, error: "runtime_unavailable" },
      503,
    );

    const noTaskService = makeCtx("POST", "/api/background/run-due-tasks", {
      getService: vi.fn(() => null),
    });
    await expect(handleBackgroundTasksRoute(noTaskService.ctx)).resolves.toBe(
      true,
    );
    expect(noTaskService.json).toHaveBeenCalledWith(
      noTaskService.ctx.res,
      { ok: false, error: "task_service_unavailable" },
      503,
    );
  });

  it("does not handle other routes", async () => {
    const { ctx, json } = makeCtx("GET", "/api/health", null);
    await expect(handleBackgroundTasksRoute(ctx)).resolves.toBe(false);
    expect(json).not.toHaveBeenCalled();
  });
});
