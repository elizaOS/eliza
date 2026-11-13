import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { registerInProcessApi } from "./in-process-api";
import type { RouteKernel } from "./route-kernel";
import { callSelfApi } from "./self-api";
import { setSelfApiTcpListenerBound } from "./self-api-endpoint";

afterEach(() => {
  setSelfApiTcpListenerBound(undefined);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function inProcessFixture() {
  const runtime = {} as IAgentRuntime;
  const seen: string[] = [];
  const kernel: RouteKernel = {
    async handle(req, res) {
      seen.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");
      res.statusCode = 200;
      res.end(JSON.stringify({ entries: [] }));
    },
  };
  return { runtime, seen, unregister: registerInProcessApi(runtime, kernel) };
}

it("runs the route in process when no listener is bound", async () => {
  setSelfApiTcpListenerBound(false);
  const fetchSpy = vi.fn();
  vi.stubGlobal("fetch", fetchSpy);
  const { runtime, seen, unregister } = inProcessFixture();
  try {
    const response = await callSelfApi({
      runtime,
      path: "/api/logs",
      query: { level: "warn" },
      isAuthorized: () => true,
      timeoutMs: 1000,
    });
    expect(response).toEqual({ status: 200, body: { entries: [] } });
    expect(seen).toEqual(["/api/logs?level=warn"]);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    unregister();
  }
});

it("refuses an unauthorized in-process call without reaching the route", async () => {
  setSelfApiTcpListenerBound(false);
  const { runtime, seen, unregister } = inProcessFixture();
  try {
    const response = await callSelfApi({
      runtime,
      path: "/api/logs",
      isAuthorized: () => false,
      timeoutMs: 1000,
    });
    expect(response.status).toBe(401);
    expect(seen).toEqual([]);
  } finally {
    unregister();
  }
});

it("uses HTTP to its own listener when one is bound", async () => {
  setSelfApiTcpListenerBound(true);
  vi.stubEnv("ELIZA_API_PORT", "");
  vi.stubEnv("ELIZA_PORT", "2140");
  vi.stubEnv("ELIZA_API_BIND_HOST", "127.0.0.1");
  vi.stubEnv("ELIZA_API_TOKEN", "self-token");
  const fetchSpy = vi.fn(
    async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  );
  vi.stubGlobal("fetch", fetchSpy);
  const { runtime, seen, unregister } = inProcessFixture();
  try {
    const response = await callSelfApi({
      runtime,
      path: "/api/wallet/config",
      isAuthorized: () => true,
      timeoutMs: 1000,
    });
    expect(response).toEqual({ status: 200, body: { ok: true } });
    expect(seen).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("http://127.0.0.1:2140/api/wallet/config");
    expect(init.headers).toEqual({ Authorization: "Bearer self-token" });
  } finally {
    unregister();
  }
});
