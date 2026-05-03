import { describe, expect, it } from "bun:test";
import type { IAgentRuntime, RouteRequest, RouteResponse } from "@elizaos/core";
import { claudeCodeWorkbenchRoutes } from "../routes.ts";
import type { WorkbenchRunResult } from "../services/workbench-service.ts";

function createResponseRecorder(): {
  res: RouteResponse;
  statusCode: () => number;
  body: () => unknown;
} {
  let code = 200;
  let payload: unknown;

  const res: RouteResponse = {
    status(nextCode: number) {
      code = nextCode;
      return this;
    },
    json(data: unknown) {
      payload = data;
      return this;
    },
    send(data: unknown) {
      payload = data;
      return this;
    },
    end() {
      return this;
    },
  };

  return {
    res,
    statusCode: () => code,
    body: () => payload,
  };
}

function findRoute(path: string) {
  const route = claudeCodeWorkbenchRoutes.find((entry) => entry.path === path);
  if (!route || !route.handler) {
    throw new Error(`Missing route: ${path}`);
  }
  return route;
}

describe("claudeCodeWorkbenchRoutes", () => {
  it("declares routes as private", () => {
    for (const route of claudeCodeWorkbenchRoutes) {
      expect(route.public).toBe(false);
    }
  });

  it("returns status data", async () => {
    const route = findRoute("/status");
    const recorder = createResponseRecorder();

    const runtime = {
      getService: () => ({
        getStatus: () => ({ available: true, timeoutMs: 1000 }),
      }),
    } as unknown as IAgentRuntime;

    await route.handler({} as RouteRequest, recorder.res, runtime);

    expect(recorder.statusCode()).toBe(200);
    expect(recorder.body()).toEqual({
      ok: true,
      status: { available: true, timeoutMs: 1000 },
    });
  });

  it("returns workflows data", async () => {
    const route = findRoute("/workflows");
    const recorder = createResponseRecorder();

    const runtime = {
      getService: () => ({
        listWorkflows: () => [{ id: "check", enabled: true }],
      }),
    } as unknown as IAgentRuntime;

    await route.handler({} as RouteRequest, recorder.res, runtime);

    expect(recorder.statusCode()).toBe(200);
    expect(recorder.body()).toEqual({
      ok: true,
      workflows: [{ id: "check", enabled: true }],
    });
  });

  it("returns 400 for invalid run payload", async () => {
    const route = findRoute("/run");
    const recorder = createResponseRecorder();

    const runtime = {
      getService: () => ({
        run: async () => {
          throw new Error("should not run");
        },
      }),
    } as unknown as IAgentRuntime;

    await route.handler({ body: {} } as RouteRequest, recorder.res, runtime);

    expect(recorder.statusCode()).toBe(400);
    expect(recorder.body()).toEqual({
      ok: false,
      error:
        "Invalid run request. Provide non-empty `workflow` in request body.",
    });
  });

  it("runs workflow and returns result", async () => {
    const route = findRoute("/run");
    const recorder = createResponseRecorder();

    const result: WorkbenchRunResult = {
      ok: true,
      workflow: "check",
      command: "bun",
      args: ["run", "check"],
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 12,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    };

    const runtime = {
      getService: () => ({
        run: async () => result,
      }),
    } as unknown as IAgentRuntime;

    await route.handler(
      { body: { workflow: "check" } } as RouteRequest,
      recorder.res,
      runtime,
    );

    expect(recorder.statusCode()).toBe(200);
    expect(recorder.body()).toEqual({ ok: true, result });
  });
});
