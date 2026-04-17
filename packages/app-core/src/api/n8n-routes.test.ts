import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { N8nSidecar, N8nSidecarState } from "../services/n8n-sidecar";
import { handleN8nRoutes, type N8nRoutesConfigLike } from "./n8n-routes";

// ── Test helpers ────────────────────────────────────────────────────────────

function makeSidecarStub(
  state: Partial<N8nSidecarState>,
  apiKey: string | null = null,
): N8nSidecar {
  return {
    getState: () => ({
      status: "stopped",
      host: null,
      port: null,
      errorMessage: null,
      pid: null,
      retries: 0,
      ...state,
    }),
    getApiKey: () => apiKey,
    start: vi.fn(async () => {}),
  } as unknown as N8nSidecar;
}

function runtimeWithCloudAuth(isAuth: boolean): AgentRuntime {
  return {
    getService: vi.fn((name: string) =>
      name === "CLOUD_AUTH" ? { isAuthenticated: () => isAuth } : null,
    ),
  } as unknown as AgentRuntime;
}

interface MockResponseInit {
  status?: number;
  body?: unknown;
  contentType?: string;
}

function mockResponse(init: MockResponseInit = {}): Response {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? "application/json";
  const bodyStr =
    typeof init.body === "string" ? init.body : JSON.stringify(init.body ?? {});
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type" ? contentType : null,
    },
    json: async () => (typeof init.body === "string" ? {} : (init.body ?? {})),
    text: async () => bodyStr,
  } as unknown as Response;
}

interface InvokeArgs {
  method?: string;
  pathname?: string;
  config?: N8nRoutesConfigLike;
  runtime?: AgentRuntime | null;
  sidecar?: N8nSidecar | null;
  fetchImpl?: typeof fetch;
  agentId?: string;
}

interface InvokeResult {
  handled: boolean;
  status: number;
  payload: unknown;
}

async function invoke(args: InvokeArgs): Promise<InvokeResult> {
  let payload: unknown = null;
  let status = 200;
  const handled = await handleN8nRoutes({
    req: {} as never,
    res: {} as never,
    method: args.method ?? "GET",
    pathname: args.pathname ?? "/api/n8n/status",
    config: args.config ?? ({} as N8nRoutesConfigLike),
    runtime: args.runtime ?? null,
    n8nSidecar: args.sidecar ?? null,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    json: (_res, data, s = 200) => {
      payload = data;
      status = s;
    },
  });
  return { handled, status, payload };
}

// ── Status route (unchanged behavior) ───────────────────────────────────────

describe("n8n status route", () => {
  it("ignores unrelated paths", async () => {
    const { handled } = await invoke({ pathname: "/api/cloud/status" });
    expect(handled).toBe(false);
  });

  it("ignores non-handled method/path combos", async () => {
    const { handled } = await invoke({
      method: "PATCH",
      pathname: "/api/n8n/status",
    });
    expect(handled).toBe(false);
  });

  it("reports cloud mode when cloud is enabled + authenticated", async () => {
    const { handled, payload } = await invoke({
      config: { cloud: { enabled: true } },
      runtime: runtimeWithCloudAuth(true),
    });
    expect(handled).toBe(true);
    expect(payload).toMatchObject({
      mode: "cloud",
      cloudConnected: true,
      host: null,
    });
  });

  it("reports cloud mode via api-key fallback when no runtime", async () => {
    const { payload } = await invoke({
      config: { cloud: { enabled: true, apiKey: "sk-xxx" } },
    });
    expect(payload).toMatchObject({
      mode: "cloud",
      cloudConnected: true,
    });
  });

  it("falls back to local mode when cloud disabled + localEnabled=true", async () => {
    const sidecar = makeSidecarStub({
      status: "ready",
      host: "http://127.0.0.1:5678",
      port: 5678,
    });
    const { payload } = await invoke({
      config: { n8n: { localEnabled: true } },
      sidecar,
    });
    expect(payload).toMatchObject({
      mode: "local",
      host: "http://127.0.0.1:5678",
      status: "ready",
      cloudConnected: false,
    });
  });

  it("reports disabled when no cloud + localEnabled=false", async () => {
    const { payload } = await invoke({
      config: { n8n: { localEnabled: false } },
    });
    expect(payload).toMatchObject({
      mode: "disabled",
      host: null,
      status: "stopped",
    });
  });

  it("never leaks the api key in the response", async () => {
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "SECRET_KEY",
    );
    const { payload } = await invoke({
      config: { n8n: { localEnabled: true } },
      sidecar,
    });
    expect(JSON.stringify(payload)).not.toContain("SECRET_KEY");
  });
});

// ── GET /api/n8n/workflows proxy ────────────────────────────────────────────

describe("n8n list workflows", () => {
  it("returns 503 when cloud disabled + local sidecar not ready", async () => {
    const sidecar = makeSidecarStub({ status: "stopped" });
    const { handled, status, payload } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows",
      config: { n8n: { localEnabled: true } },
      sidecar,
    });
    expect(handled).toBe(true);
    expect(status).toBe(503);
    expect(payload).toMatchObject({ status: "stopped" });
  });

  it("returns 503 when disabled entirely", async () => {
    const { status, payload } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows",
      config: { n8n: { localEnabled: false } },
    });
    expect(status).toBe(503);
    expect(payload).toMatchObject({ error: "n8n disabled", status: "stopped" });
  });

  it("proxies to cloud gateway with Bearer auth + agent id", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: {
          data: [
            { id: "w1", name: "Hello", active: true, nodes: [{ id: "n1" }] },
          ],
        },
      }),
    ) as unknown as typeof fetch;

    const { status, payload } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows",
      config: {
        cloud: {
          enabled: true,
          apiKey: "cloud-key",
          baseUrl: "https://cloud.example.com",
        },
      },
      runtime: runtimeWithCloudAuth(true),
      agentId: "agent-abc",
      fetchImpl,
    });

    expect(status).toBe(200);
    expect(payload).toEqual({
      workflows: [
        {
          id: "w1",
          name: "Hello",
          active: true,
          nodes: [{ id: "n1" }],
          nodeCount: 1,
        },
      ],
    });

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [calledUrl, calledInit] = calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(
      "https://cloud.example.com/api/v1/agents/agent-abc/n8n/workflows",
    );
    const headers = (calledInit.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cloud-key");
  });

  it("proxies to local sidecar with X-N8N-API-KEY header", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: {
          data: [{ id: "w2", name: "Local", active: false, nodes: [] }],
        },
      }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678", port: 5678 },
      "n8n-api-key",
    );

    const { status } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
    });
    expect(status).toBe(200);

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [calledUrl, calledInit] = calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://127.0.0.1:5678/rest/workflows");
    const headers = (calledInit.headers ?? {}) as Record<string, string>;
    expect(headers["X-N8N-API-KEY"]).toBe("n8n-api-key");
    // Must not send Authorization: Bearer for local-mode (that's cloud convention).
    expect(headers.Authorization).toBeUndefined();
  });

  it("forwards 5xx errors from upstream with {error} body", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ status: 502, body: { error: "upstream gateway bad" } }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );

    const { status, payload } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
    });
    expect(status).toBe(502);
    expect(payload).toMatchObject({ error: "upstream gateway bad" });
  });

  it("normalizes {workflows: [...]} cloud-gateway shape", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: {
          workflows: [{ id: "w3", name: "From Gateway", active: true }],
        },
      }),
    ) as unknown as typeof fetch;
    const { payload } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows",
      config: {
        cloud: { enabled: true, apiKey: "k", baseUrl: "https://c.example" },
      },
      runtime: runtimeWithCloudAuth(true),
      fetchImpl,
    });
    expect(payload).toEqual({
      workflows: [
        {
          id: "w3",
          name: "From Gateway",
          active: true,
          nodes: [],
          nodeCount: 0,
        },
      ],
    });
  });

  it("strips credential data from node descriptors", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: {
          data: [
            {
              id: "w4",
              name: "Creds",
              active: true,
              nodes: [
                {
                  id: "n1",
                  name: "HTTP",
                  type: "http",
                  credentials: { apiKey: "SECRET_CRED" },
                },
              ],
            },
          ],
        },
      }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );
    const { payload } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
    });
    expect(JSON.stringify(payload)).not.toContain("SECRET_CRED");
  });
});

// ── Activate / Deactivate ───────────────────────────────────────────────────

describe("n8n toggle workflow", () => {
  it("activates via POST /workflows/{id}/activate", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: { data: { id: "w1", name: "Hello", active: true, nodes: [] } },
      }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );

    const { status, payload } = await invoke({
      method: "POST",
      pathname: "/api/n8n/workflows/w1/activate",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
    });
    expect(status).toBe(200);
    expect(payload).toMatchObject({ id: "w1", active: true, nodeCount: 0 });

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [calledUrl, init] = calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://127.0.0.1:5678/rest/workflows/w1/activate");
    expect(init.method).toBe("POST");
  });

  it("deactivates via POST /workflows/{id}/deactivate", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: { data: { id: "w2", name: "Hello", active: false, nodes: [] } },
      }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );
    const { status, payload } = await invoke({
      method: "POST",
      pathname: "/api/n8n/workflows/w2/deactivate",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
    });
    expect(status).toBe(200);
    expect(payload).toMatchObject({ id: "w2", active: false });
  });

  it("returns 503 when sidecar is starting", async () => {
    const sidecar = makeSidecarStub({ status: "starting" });
    const { status, payload } = await invoke({
      method: "POST",
      pathname: "/api/n8n/workflows/w1/activate",
      config: { n8n: { localEnabled: true } },
      sidecar,
    });
    expect(status).toBe(503);
    expect(payload).toMatchObject({ status: "starting" });
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe("n8n delete workflow", () => {
  it("returns {ok: true} on success", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: {} }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );
    const { status, payload } = await invoke({
      method: "DELETE",
      pathname: "/api/n8n/workflows/w9",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
    });
    expect(status).toBe(200);
    expect(payload).toEqual({ ok: true });

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [calledUrl, init] = calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://127.0.0.1:5678/rest/workflows/w9");
    expect(init.method).toBe("DELETE");
  });

  it("returns 404 passthrough when upstream 404s", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ status: 404, body: { error: "not found" } }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );
    const { status } = await invoke({
      method: "DELETE",
      pathname: "/api/n8n/workflows/missing",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
    });
    expect(status).toBe(404);
  });
});

// ── Sidecar start ───────────────────────────────────────────────────────────

describe("n8n sidecar start", () => {
  it("fires start() and returns 202", async () => {
    const start = vi.fn(async () => {});
    const sidecar = {
      getState: () => ({
        status: "stopped",
        host: null,
        port: null,
        errorMessage: null,
        pid: null,
        retries: 0,
      }),
      getApiKey: () => null,
      start,
    } as unknown as N8nSidecar;
    const { status, payload } = await invoke({
      method: "POST",
      pathname: "/api/n8n/sidecar/start",
      config: { n8n: { localEnabled: true, version: "1.70.0" } },
      sidecar,
    });
    expect(status).toBe(202);
    expect(payload).toEqual({ ok: true });
    expect(start).toHaveBeenCalled();
  });
});

// ── Gate behavior ───────────────────────────────────────────────────────────
//
// The auth check lives in server.ts (ensureCompatApiAuthorized) and sits in
// front of every /api/n8n/* route. Here we confirm handleN8nRoutes doesn't
// short-circuit for paths it doesn't know about — the server gate then lets
// the outer handler emit a 404.

describe("n8n route gate", () => {
  it("returns false for unknown /api/n8n/ paths", async () => {
    const { handled } = await invoke({
      method: "GET",
      pathname: "/api/n8n/unknown",
    });
    expect(handled).toBe(false);
  });

  it("returns false for a GET on a POST-only workflow action", async () => {
    const { handled } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows/w1/activate",
    });
    expect(handled).toBe(false);
  });
});
