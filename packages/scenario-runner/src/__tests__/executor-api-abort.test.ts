/**
 * Regression tests for #24531: scenario `api` turns must abort their fetch when
 * the turn deadline expires (or the caller cancels) so a hung route cannot
 * retain sockets/work after the scenario turn has already failed, and response
 * body consumption stays inside the same cancellation boundary. Uses the real
 * `runScenario` executor with its real loopback API server and real fetch; only
 * the runtime is the package's standard stub.
 */
import type {
  AgentRuntime,
  Route,
  RouteRequest,
  RouteResponse,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { runScenario } from "../executor.js";

function createRuntime(routes: Route[]): AgentRuntime {
  return {
    actions: [],
    agentId: "00000000-0000-4000-8000-000000000001",
    plugins: [],
    routes,
    ensureConnection: async () => undefined,
    getService: () => null,
    reportError: () => {},
    setSetting: () => {},
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as AgentRuntime;
}

/** Route handler that never completes the response; records socket teardown. */
function hangHandler(onClose: () => void) {
  return async (_req: RouteRequest, res: RouteResponse) => {
    (res as unknown as NodeJS.EventEmitter).on("close", onClose);
    // Intentionally never responds.
  };
}

describe("scenario executor api turn cancellation", () => {
  it("aborts a hung api fetch when the turn timeout expires", {
    timeout: 30_000,
  }, async () => {
    let serverSawClose = false;
    const runtime = createRuntime([
      {
        type: "GET",
        path: "/hang",
        handler: hangHandler(() => {
          serverSawClose = true;
        }),
      },
    ]);

    const report = await runScenario(
      {
        id: "api-abort-timeout",
        title: "API turn aborts hung fetch on timeout",
        domain: "executor",
        turns: [
          {
            kind: "api",
            name: "hung",
            method: "GET",
            path: "/hang",
            timeoutMs: 250,
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 20_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.error).toContain("api(hung) timed out after 250ms");
    // The abort must reach the server side: the destroyed client socket
    // fires `close` on the server response object. `runScenario` only
    // resolves after its loopback server closed, which itself requires the
    // hung connection to be released (on unfixed code this never happens).
    await vi.waitFor(() => {
      expect(serverSawClose).toBe(true);
    });
  });

  it("aborts a stalled response body within the same turn deadline", {
    timeout: 30_000,
  }, async () => {
    const runtime = createRuntime([
      {
        type: "GET",
        path: "/drip",
        handler: async (_req: RouteRequest, res: RouteResponse) => {
          // Headers + partial body, then the stream never ends: the fetch
          // resolves while body consumption would hang forever without the
          // abort signal spanning `response.text()`.
          const raw = res as unknown as {
            writeHead: (
              status: number,
              headers: Record<string, string>,
            ) => void;
            write: (chunk: string) => void;
          };
          raw.writeHead(200, { "content-type": "application/json" });
          raw.write('{"partial":');
        },
      },
    ]);

    const report = await runScenario(
      {
        id: "api-abort-drip",
        title: "API turn aborts stalled response body",
        domain: "executor",
        turns: [
          {
            kind: "api",
            name: "drip",
            method: "GET",
            path: "/drip",
            timeoutMs: 250,
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 20_000,
      },
    );

    expect(report.status).toBe("failed");
    expect(report.error).toContain("api(drip) timed out after 250ms");
  });

  it("aborts the request when the caller aborts the scenario mid-turn", {
    timeout: 30_000,
  }, async () => {
    let serverSawClose = false;
    const runtime = createRuntime([
      {
        type: "GET",
        path: "/hang",
        handler: hangHandler(() => {
          serverSawClose = true;
        }),
      },
    ]);
    const callerController = new AbortController();
    setTimeout(
      () =>
        callerController.abort(
          new Error("scenario cancelled by caller mid-turn"),
        ),
      150,
    );

    const report = await runScenario(
      {
        id: "api-abort-caller",
        title: "API turn aborts when the caller aborts",
        domain: "executor",
        turns: [
          {
            kind: "api",
            name: "hung",
            method: "GET",
            path: "/hang",
          },
        ],
      },
      runtime,
      {
        minJudgeScore: 0.8,
        providerName: "unit-test",
        turnTimeoutMs: 20_000,
        abortSignal: callerController.signal,
      },
    );

    expect(report.status).toBe("failed");
    // The caller's abort reason must surface verbatim, not a generic label.
    expect(report.error).toContain("scenario cancelled by caller mid-turn");
    await vi.waitFor(() => {
      expect(serverSawClose).toBe(true);
    });
  });
});
