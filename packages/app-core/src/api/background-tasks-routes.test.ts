import * as http from "node:http";
import { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { handleBackgroundTasksRoute } from "./background-tasks-routes";
import type { CompatRuntimeState } from "./compat-route-shared";

vi.mock("@elizaos/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/core")>();
  return {
    ...actual,
    ServiceType: { TASK: "task" },
  };
});

vi.mock("./auth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.ts")>();
  return {
    ...actual,
    ensureRouteAuthorized: vi.fn(async () => true),
  };
});

interface FakeRes {
  res: http.ServerResponse;
  body(): unknown;
  status(): number;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body() {
      return bodyText.length > 0 ? JSON.parse(bodyText) : null;
    },
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(pathname: string): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = "POST";
  req.url = pathname;
  req.headers = { host: "127.0.0.1:31337" };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: "127.0.0.1",
    configurable: true,
  });
  return req;
}

function stateWithTaskService(service: unknown): CompatRuntimeState {
  return {
    current: {
      getService: () => service,
    } as unknown as CompatRuntimeState["current"],
    pendingAgentName: null,
    pendingRestartReasons: [],
  };
}

describe("POST /api/background/run-due-tasks", () => {
  it("routes native wakes into the canonical TaskService runner", async () => {
    const runDueTasks = vi.fn(async () => {});
    const res = fakeRes();

    const handled = await handleBackgroundTasksRoute(
      fakeReq("/api/background/run-due-tasks"),
      res.res,
      stateWithTaskService({ runDueTasks }),
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(200);
    expect(res.body()).toMatchObject({ ok: true, coalesced: false });
    expect(runDueTasks).toHaveBeenCalledTimes(1);
  });

  it("reports unavailable task service without adding a second scheduler", async () => {
    const res = fakeRes();

    const handled = await handleBackgroundTasksRoute(
      fakeReq("/api/background/run-due-tasks"),
      res.res,
      stateWithTaskService(null),
    );

    expect(handled).toBe(true);
    expect(res.status()).toBe(503);
    expect(res.body()).toEqual({
      ok: false,
      error: "task_service_unavailable",
    });
  });

  it("coalesces concurrent native wakes into one TaskService run", async () => {
    let resolveRun: (() => void) | undefined;
    const runDueTasks = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveRun = resolve;
        }),
    );
    const firstRes = fakeRes();
    const secondRes = fakeRes();
    const state = stateWithTaskService({ runDueTasks });

    const first = handleBackgroundTasksRoute(
      fakeReq("/api/background/run-due-tasks"),
      firstRes.res,
      state,
    );
    await vi.waitFor(() => expect(runDueTasks).toHaveBeenCalledTimes(1));

    const second = handleBackgroundTasksRoute(
      fakeReq("/api/background/run-due-tasks"),
      secondRes.res,
      state,
    );
    resolveRun?.();

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(runDueTasks).toHaveBeenCalledTimes(1);
    expect(firstRes.body()).toMatchObject({ ok: true, coalesced: false });
    expect(secondRes.body()).toMatchObject({ ok: true, coalesced: true });
  });

  it("leaves unrelated paths unhandled", async () => {
    const res = fakeRes();
    const handled = await handleBackgroundTasksRoute(
      fakeReq("/api/background/other"),
      res.res,
      stateWithTaskService(null),
    );
    expect(handled).toBe(false);
  });
});
