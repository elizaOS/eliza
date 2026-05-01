import { Readable } from "node:stream";
import type { AgentRuntime } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { N8nSidecar, N8nSidecarState } from "../services/n8n-sidecar";
import {
  __resetCloudHealthCacheForTests,
  handleN8nRoutes,
  type N8nCloudHealth,
  type N8nRoutesConfigLike,
} from "./n8n-routes";

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
  isNativePlatform?: boolean;
  cloudHealthOverride?: N8nCloudHealth;
  body?: Record<string, unknown>;
}

interface InvokeResult {
  handled: boolean;
  status: number;
  payload: unknown;
}

async function invoke(args: InvokeArgs): Promise<InvokeResult> {
  let payload: unknown = null;
  let status = 200;
  const reqBody =
    args.body === undefined ? [] : [Buffer.from(JSON.stringify(args.body))];
  const handled = await handleN8nRoutes({
    req: Readable.from(reqBody) as never,
    res: {} as never,
    method: args.method ?? "GET",
    pathname: args.pathname ?? "/api/n8n/status",
    config: args.config ?? ({} as N8nRoutesConfigLike),
    runtime: args.runtime ?? null,
    n8nSidecar: args.sidecar ?? null,
    ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
    ...(args.agentId ? { agentId: args.agentId } : {}),
    ...(args.isNativePlatform !== undefined
      ? { isNativePlatform: args.isNativePlatform }
      : {}),
    ...(args.cloudHealthOverride !== undefined
      ? { cloudHealthOverride: args.cloudHealthOverride }
      : {}),
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
      platform: "desktop",
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

// ── Cloud health probe ──────────────────────────────────────────────────────

describe("n8n status cloudHealth", () => {
  beforeEach(() => {
    __resetCloudHealthCacheForTests();
  });

  it("returns cloudHealth=unknown in local mode", async () => {
    const { payload } = await invoke({
      config: { n8n: { localEnabled: true } },
    });
    expect(payload).toMatchObject({ mode: "local", cloudHealth: "unknown" });
  });

  it("returns cloudHealth=ok when cloud health probe returns 200", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ status: 200, body: { ok: true } }),
    ) as unknown as typeof fetch;
    const { payload } = await invoke({
      config: {
        cloud: {
          enabled: true,
          apiKey: "k",
          baseUrl: "https://cloud.example.com",
        },
      },
      runtime: runtimeWithCloudAuth(true),
      fetchImpl,
    });
    expect(payload).toMatchObject({ mode: "cloud", cloudHealth: "ok" });
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [calledUrl] = calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("https://cloud.example.com/api/v1/health");
  });

  it("returns cloudHealth=degraded on non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ status: 503, body: { error: "boom" } }),
    ) as unknown as typeof fetch;
    const { payload } = await invoke({
      config: {
        cloud: {
          enabled: true,
          apiKey: "k",
          baseUrl: "https://cloud.example.com",
        },
      },
      runtime: runtimeWithCloudAuth(true),
      fetchImpl,
    });
    expect(payload).toMatchObject({
      mode: "cloud",
      cloudConnected: true,
      cloudHealth: "degraded",
    });
  });

  it("returns cloudHealth=degraded on fetch failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { payload } = await invoke({
      config: {
        cloud: {
          enabled: true,
          apiKey: "k",
          baseUrl: "https://cloud.example.com",
        },
      },
      runtime: runtimeWithCloudAuth(true),
      fetchImpl,
    });
    expect(payload).toMatchObject({ mode: "cloud", cloudHealth: "degraded" });
  });

  it("caches the probe for subsequent calls (single fetch per 30s)", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({ status: 200, body: { ok: true } }),
    ) as unknown as typeof fetch;
    const args: InvokeArgs = {
      config: {
        cloud: {
          enabled: true,
          apiKey: "k",
          baseUrl: "https://cloud.example.com",
        },
      },
      runtime: runtimeWithCloudAuth(true),
      fetchImpl,
    };
    await invoke(args);
    await invoke(args);
    await invoke(args);
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls.length).toBe(1);
  });

  it("respects cloudHealthOverride (test escape hatch)", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const { payload } = await invoke({
      config: {
        cloud: { enabled: true, apiKey: "k", baseUrl: "https://c.example" },
      },
      runtime: runtimeWithCloudAuth(true),
      fetchImpl,
      cloudHealthOverride: "degraded",
    });
    expect(payload).toMatchObject({ cloudHealth: "degraded" });
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    expect(calls.length).toBe(0);
  });
});

// ── Mobile (native) platform behaviour ──────────────────────────────────────
//
// On iOS / Android the local n8n sidecar cannot run because the embedded
// Capacitor runtime has no `node:child_process`. The status route must
// report `platform: "mobile"`, force `localEnabled: false` even when the
// stored config says otherwise, and the `/sidecar/start` endpoint must
// refuse with a 409.

describe("n8n mobile platform", () => {
  it("adds platform=mobile to status and forces localEnabled=false", async () => {
    const { payload } = await invoke({
      pathname: "/api/n8n/status",
      // Stored user setting says local is enabled — mobile override must
      // flip the read-time view to disabled without touching config.
      config: { n8n: { localEnabled: true } },
      isNativePlatform: true,
    });
    expect(payload).toMatchObject({
      mode: "disabled",
      host: null,
      status: "stopped",
      cloudConnected: false,
      localEnabled: false,
      platform: "mobile",
    });
  });

  it("still reports cloud mode on mobile when cloud is authenticated", async () => {
    const { payload } = await invoke({
      pathname: "/api/n8n/status",
      config: { cloud: { enabled: true, apiKey: "sk-mobile" } },
      isNativePlatform: true,
    });
    expect(payload).toMatchObject({
      mode: "cloud",
      cloudConnected: true,
      platform: "mobile",
      // localEnabled remains false on mobile even when cloud is connected —
      // the local sidecar is fundamentally unreachable from this platform.
      localEnabled: false,
    });
  });

  it("rejects POST /api/n8n/sidecar/start with 409 on mobile", async () => {
    const { handled, status, payload } = await invoke({
      method: "POST",
      pathname: "/api/n8n/sidecar/start",
      config: { n8n: { localEnabled: true } },
      isNativePlatform: true,
    });
    expect(handled).toBe(true);
    expect(status).toBe(409);
    expect(payload).toEqual({
      error: "Local n8n not supported on mobile. Use Eliza Cloud.",
      platform: "mobile",
    });
  });

  it("returns 503 disabled for /api/n8n/workflows on mobile without cloud", async () => {
    const { status, payload } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows",
      config: { n8n: { localEnabled: true } },
      isNativePlatform: true,
    });
    expect(status).toBe(503);
    expect(payload).toMatchObject({ error: "n8n disabled", status: "stopped" });
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
    expect(calledUrl).toBe("http://127.0.0.1:5678/api/v1/workflows");
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

// ── GET /api/n8n/workflows/:id (single workflow with full graph) ────────────

describe("n8n get single workflow", () => {
  it("returns connections and node positions from upstream", async () => {
    const upstreamWorkflow = {
      id: "w-graph",
      name: "Graph Workflow",
      active: true,
      nodes: [
        {
          id: "n1",
          name: "Schedule Trigger",
          type: "n8n-nodes-base.scheduleTrigger",
          position: [250, 300],
        },
        {
          id: "n2",
          name: "Send Email",
          type: "n8n-nodes-base.gmail",
          position: [450, 300],
          parameters: { to: "test@example.com" },
        },
      ],
      connections: {
        "Schedule Trigger": {
          main: [[{ node: "Send Email", type: "main", index: 0 }]],
        },
      },
    };
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: upstreamWorkflow }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );

    const { status, payload } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows/w-graph",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
    });

    expect(status).toBe(200);
    const w = payload as Record<string, unknown>;
    expect(w.id).toBe("w-graph");
    expect(w.nodeCount).toBe(2);

    const nodes = w.nodes as Array<Record<string, unknown>>;
    expect(nodes[0]?.position).toEqual([250, 300]);
    expect(nodes[1]?.position).toEqual([450, 300]);
    expect((nodes[1]?.parameters as Record<string, unknown>)?.to).toBe(
      "test@example.com",
    );

    // connections must be forwarded from upstream
    const connections = w.connections as Record<string, unknown>;
    expect(connections).toBeDefined();
    expect(Object.keys(connections)).toContain("Schedule Trigger");

    // Confirm the right URL was called
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [calledUrl] = calls[0] as [string];
    expect(calledUrl).toBe("http://127.0.0.1:5678/api/v1/workflows/w-graph");
  });

  it("strips credentials from nodes even in full GET", async () => {
    const upstreamWorkflow = {
      id: "w-cred",
      name: "Cred Workflow",
      active: false,
      nodes: [
        {
          id: "n1",
          name: "HTTP",
          type: "n8n-nodes-base.httpRequest",
          position: [100, 100],
          credentials: { api: "SECRET" },
          parameters: { url: "https://example.com" },
        },
      ],
      connections: {},
    };
    const fetchImpl = vi.fn(async () =>
      mockResponse({ body: upstreamWorkflow }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );

    const { payload } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows/w-cred",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
    });
    expect(JSON.stringify(payload)).not.toContain("SECRET");
    const nodes = (payload as Record<string, unknown>).nodes as Array<
      Record<string, unknown>
    >;
    expect(nodes[0]?.position).toEqual([100, 100]);
    expect((nodes[0]?.parameters as Record<string, unknown>)?.url).toBe(
      "https://example.com",
    );
  });

  it("returns 503 when sidecar not ready", async () => {
    const sidecar = makeSidecarStub({ status: "stopped" });
    const { status } = await invoke({
      method: "GET",
      pathname: "/api/n8n/workflows/w1",
      config: { n8n: { localEnabled: true } },
      sidecar,
    });
    expect(status).toBe(503);
  });
});

// ── Create / Update / Generate ──────────────────────────────────────────────

describe("n8n write workflows", () => {
  const workflowBody = {
    name: "QA workflow",
    nodes: [
      {
        name: "Start",
        type: "n8n-nodes-base.manualTrigger",
        typeVersion: 1,
        position: [0, 0],
        parameters: {},
      },
      {
        name: "Step",
        type: "n8n-nodes-base.noOp",
        typeVersion: 1,
        position: [260, 0],
        parameters: {},
        notes: "Do the work",
        notesInFlow: true,
      },
    ],
    connections: {
      Start: { main: [[{ node: "Step", type: "main", index: 0 }]] },
    },
    settings: {},
  };

  it("creates via POST /workflows and strips unsafe fields", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: { id: "created", active: false, ...workflowBody },
      }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );

    const { status, payload } = await invoke({
      method: "POST",
      pathname: "/api/n8n/workflows",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
      body: {
        ...workflowBody,
        id: "should-not-forward",
        nodes: [
          {
            ...(workflowBody.nodes[0] as Record<string, unknown>),
            credentials: { api: { id: "cred-id", name: "Cred" } },
            extra: "drop me",
          },
          workflowBody.nodes[1],
        ],
      },
    });

    expect(status).toBe(200);
    expect(payload).toMatchObject({ id: "created", nodeCount: 2 });

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [calledUrl, init] = calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://127.0.0.1:5678/api/v1/workflows");
    expect(init.method).toBe("POST");
    const forwarded = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(forwarded.id).toBeUndefined();
    const forwardedNodes = forwarded.nodes as Array<Record<string, unknown>>;
    expect(forwardedNodes[0]?.extra).toBeUndefined();
    expect(forwardedNodes[0]?.credentials).toEqual({
      api: { id: "cred-id", name: "Cred" },
    });
  });

  it("updates via PUT /workflows/{id}", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: { id: "w-update", active: false, ...workflowBody },
      }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );

    const { status } = await invoke({
      method: "PUT",
      pathname: "/api/n8n/workflows/w-update",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
      body: workflowBody,
    });
    expect(status).toBe(200);

    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } })
      .mock.calls;
    const [calledUrl, init] = calls[0] as [string, RequestInit];
    expect(calledUrl).toBe("http://127.0.0.1:5678/api/v1/workflows/w-update");
    expect(init.method).toBe("PUT");
  });

  it("returns 503 when no workflow service is registered", async () => {
    const fetchImpl = vi.fn(async () =>
      mockResponse({
        body: { id: "unexpected" },
      }),
    ) as unknown as typeof fetch;
    const sidecar = makeSidecarStub(
      { status: "ready", host: "http://127.0.0.1:5678" },
      "k",
    );

    const { status, payload } = await invoke({
      method: "POST",
      pathname: "/api/n8n/workflows/generate",
      config: { n8n: { localEnabled: true } },
      sidecar,
      fetchImpl,
      body: {
        prompt: "When a message arrives, summarize it then post a reply",
      },
    });

    expect(status).toBe(503);
    expect(payload).toEqual({ error: "n8n workflow service unavailable" });
    expect(fetchImpl).not.toHaveBeenCalled();
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
    expect(calledUrl).toBe(
      "http://127.0.0.1:5678/api/v1/workflows/w1/activate",
    );
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
    expect(calledUrl).toBe("http://127.0.0.1:5678/api/v1/workflows/w9");
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

// ── handleGenerateWorkflow → deployWorkflow path ────────────────────────────
//
// Pins the post-Session-19 behavior of POST /api/n8n/workflows/generate:
// when the n8n_workflow service is registered, the route MUST go through
// service.generateWorkflowDraft → service.deployWorkflow → service.getWorkflow
// (with userId = resolveAgentId(ctx)) so credential resolution runs
// server-side. Without this, generated workflows reach n8n with
// `{{CREDENTIAL_ID}}` placeholders unresolved and crash on activate. A
// future refactor that silently reverts to the legacy proxy path would be
// caught here.

interface MockGenerateService {
  generateWorkflowDraft: ReturnType<typeof vi.fn>;
  deployWorkflow: ReturnType<typeof vi.fn>;
  getWorkflow: ReturnType<typeof vi.fn>;
}

function runtimeWithWorkflowService(
  service: Partial<MockGenerateService>,
): AgentRuntime {
  return {
    getService: vi.fn((name: string) =>
      name === "n8n_workflow" ? service : null,
    ),
  } as unknown as AgentRuntime;
}

describe("n8n POST /api/n8n/workflows/generate", () => {
  it("calls generateWorkflowDraft → deployWorkflow → getWorkflow in order with resolveAgentId(ctx) as userId", async () => {
    const draft = {
      name: "Test Draft",
      nodes: [],
      connections: {},
    };
    const deployed = {
      id: "wf-123",
      name: "Test Draft",
      active: false,
      nodeCount: 0,
      missingCredentials: [],
    };
    const full = {
      id: "wf-123",
      name: "Test Draft",
      nodes: [],
      connections: {},
      active: false,
    };
    const generateWorkflowDraft = vi.fn(async () => draft);
    const deployWorkflow = vi.fn(async () => deployed);
    const getWorkflow = vi.fn(async () => full);
    const service: MockGenerateService = {
      generateWorkflowDraft,
      deployWorkflow,
      getWorkflow,
    };
    const runtime = runtimeWithWorkflowService(service);

    const { handled, status, payload } = await invoke({
      method: "POST",
      pathname: "/api/n8n/workflows/generate",
      runtime,
      agentId: "agent-abc",
      body: { prompt: "create a hello workflow" },
    });

    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(payload).toEqual(full);

    // Argument shapes
    expect(generateWorkflowDraft).toHaveBeenCalledWith(
      "create a hello workflow",
    );
    expect(deployWorkflow).toHaveBeenCalledWith(draft, "agent-abc");
    expect(getWorkflow).toHaveBeenCalledWith("wf-123");

    // Call ordering — generate < deploy < getWorkflow
    const genOrder = generateWorkflowDraft.mock.invocationCallOrder[0];
    const deployOrder = deployWorkflow.mock.invocationCallOrder[0];
    const getOrder = getWorkflow.mock.invocationCallOrder[0];
    expect(genOrder).toBeLessThan(deployOrder);
    expect(deployOrder).toBeLessThan(getOrder);
  });

  it("short-circuits with warning when deployWorkflow reports missingCredentials and skips getWorkflow", async () => {
    const draft = { name: "Gmail Draft", nodes: [], connections: {} };
    const deployed = {
      id: "wf-456",
      name: "Gmail Draft",
      active: false,
      nodeCount: 0,
      missingCredentials: [
        {
          credType: "gmailOAuth2",
          authUrl: "milady://settings/connectors/gmail",
        },
      ],
    };
    const generateWorkflowDraft = vi.fn(async () => draft);
    const deployWorkflow = vi.fn(async () => deployed);
    const getWorkflow = vi.fn(async () => ({}));
    const service: MockGenerateService = {
      generateWorkflowDraft,
      deployWorkflow,
      getWorkflow,
    };
    const runtime = runtimeWithWorkflowService(service);

    const { status, payload } = await invoke({
      method: "POST",
      pathname: "/api/n8n/workflows/generate",
      runtime,
      agentId: "agent-abc",
      body: { prompt: "send my Gmail summary to Discord" },
    });

    expect(status).toBe(200);
    expect(payload).toMatchObject({
      id: "wf-456",
      missingCredentials: deployed.missingCredentials,
      warning: "missing credentials",
    });
    expect(getWorkflow).not.toHaveBeenCalled();
  });
});
