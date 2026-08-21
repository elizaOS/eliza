/** Exercises Discord gateway wake behavior through the real bounded PATCH helper. */

import { describe, expect, mock, test } from "bun:test";
import { observeWakeServer, wakeServer } from "../src/server-router";

const serverUrl = "http://agent-server.agents.svc:3000";
const dependencies = {
  getToken: () => "test-token",
  getCaCert: () => "test-ca",
};

describe("gateway-discord wakeServer", () => {
  test("preserves successful wake behavior", async () => {
    const logError = mock(() => undefined);
    const fetchFn = mock(async () => new Response(null, { status: 200 }));

    await wakeServer("agent-server", serverUrl, {
      ...dependencies,
      fetchFn: fetchFn as typeof fetch,
      logError,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });

  test("logs a non-2xx response exactly once", async () => {
    const logError = mock(() => undefined);

    await wakeServer("agent-server", serverUrl, {
      ...dependencies,
      fetchFn: mock(
        async () => new Response("forbidden", { status: 403 }),
      ) as typeof fetch,
      logError,
    });

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith("wakeServer failed", {
      serverName: "agent-server",
      status: 403,
      body: "forbidden",
    });
  });

  test("aborts a stalled PATCH and observes the failure once", async () => {
    const logError = mock(() => undefined);
    const fetchFn = mock(
      async (_input: string | URL | Request, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    );

    await wakeServer("agent-server", serverUrl, {
      ...dependencies,
      fetchFn: fetchFn as typeof fetch,
      createTimeoutSignal: () => AbortSignal.timeout(5),
      logError,
    });

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0]?.[0]).toBe("wakeServer error");
    expect(logError.mock.calls[0]?.[1]).toMatchObject({
      serverName: "agent-server",
      error: expect.any(String),
    });
  });

  test("observes an unexpected detached rejection without an empty catch", async () => {
    const logError = mock(() => undefined);

    observeWakeServer(
      Promise.reject(new Error("unexpected")),
      "agent-server",
      logError,
    );
    await Promise.resolve();

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError).toHaveBeenCalledWith("wakeServer unhandled error", {
      serverName: "agent-server",
      error: "unexpected",
    });
  });

  test("does not contact Kubernetes for a direct server", async () => {
    const fetchFn = mock(async () => new Response(null, { status: 200 }));

    await wakeServer("agent-server", "http://agent.example:3000", {
      ...dependencies,
      fetchFn: fetchFn as typeof fetch,
    });

    expect(fetchFn).not.toHaveBeenCalled();
  });
});
