/**
 * Unit tests for n8n-dispatch.ts — workflow execution dispatch.
 *
 * Covers:
 * - Cloud mode + 200 → { ok: true } (+ executionId if returned)
 * - Cloud mode + 401 → { ok: false, error: "n8n returned 401: ..." }
 * - Local mode + 200 → { ok: true }
 * - Local mode missing api key → { ok: false, error }
 * - Disabled mode → immediate { ok: false, error: "n8n disabled" }, no fetch
 * - Fetch throw → { ok: false, error: "n8n fetch failed: ..." }
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  createN8nDispatchService,
  type N8nDispatchConfigLike,
} from "./n8n-dispatch";

interface FakeAuth {
  isAuthenticated: () => boolean;
}

function makeRuntime(auth: FakeAuth | null, agentId = "agent-x"): AgentRuntime {
  return {
    agentId,
    getService: (name: string) =>
      name === "CLOUD_AUTH" ? (auth as unknown as object) : null,
  } as unknown as AgentRuntime;
}

interface FakeResponseInit {
  status?: number;
  statusText?: string;
  body?: unknown;
  contentType?: string;
}

function fakeResponse(init: FakeResponseInit = {}): Response {
  const status = init.status ?? 200;
  const statusText = init.statusText ?? (status === 200 ? "OK" : "ERR");
  const contentType = init.contentType ?? "application/json";
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    headers: {
      get: (k: string) =>
        k.toLowerCase() === "content-type" ? contentType : null,
    },
    json: async () => init.body ?? {},
    text: async () =>
      typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  } as unknown as Response;
}

function makeSidecarStub(
  host: string | null,
  apiKey: string | null,
): {
  getState: () => { host: string | null };
  getApiKey: () => string | null;
} {
  return {
    getState: () => ({ host }),
    getApiKey: () => apiKey,
  };
}

const cloudConfig: N8nDispatchConfigLike = {
  cloud: {
    enabled: true,
    apiKey: "cloud-key",
    baseUrl: "https://api.example.test",
  },
  n8n: { localEnabled: true },
};

const localConfig: N8nDispatchConfigLike = {
  cloud: { enabled: false },
  n8n: { localEnabled: true, host: "http://127.0.0.1:5678", apiKey: "local-k" },
};

const disabledConfig: N8nDispatchConfigLike = {
  cloud: { enabled: false },
  n8n: { localEnabled: false },
};

describe("n8n-dispatch", () => {
  it("cloud mode + 200 → { ok: true } with executionId when returned", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ status: 200, body: { executionId: "exec-123" } }),
    ) as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => true }, "agent-x");

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => cloudConfig,
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => null,
    });

    const res = await svc.execute("wf-7");
    expect(res).toEqual({ ok: true, executionId: "exec-123" });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toBe(
      "https://api.example.test/api/v1/agents/agent-x/n8n/workflows/wf-7/execute",
    );
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer cloud-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("cloud mode + 200 → { ok: true } with no executionId when absent", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ status: 200, body: {} }),
    ) as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => true });

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => cloudConfig,
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => null,
    });

    const res = await svc.execute("wf-0");
    expect(res).toEqual({ ok: true });
  });

  it("cloud mode + 401 → { ok: false, error } with status text", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ status: 401, statusText: "Unauthorized" }),
    ) as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => true });

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => cloudConfig,
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => null,
    });

    const res = await svc.execute("wf-1");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("n8n returned 401: Unauthorized");
  });

  it("local mode + 200 → { ok: true }", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ status: 200, body: {} }),
    ) as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => false });

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => localConfig,
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => makeSidecarStub("http://127.0.0.1:5678", "sidecar-k"),
    });

    const res = await svc.execute("wf-2");
    expect(res).toEqual({ ok: true });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(call[0]).toBe("http://127.0.0.1:5678/rest/workflows/wf-2/run");
    const init = call[1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-N8N-API-KEY"]).toBe("sidecar-k");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("local mode falls back to config host + api key when sidecar absent", async () => {
    const fetchImpl = vi.fn(async () =>
      fakeResponse({ status: 200, body: {} }),
    ) as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => false });

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => localConfig,
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => null,
    });

    const res = await svc.execute("wf-3");
    expect(res.ok).toBe(true);

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0];
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-N8N-API-KEY"]).toBe("local-k");
  });

  it("local mode missing api key → { ok: false, error }", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => false });

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => ({
        cloud: { enabled: false },
        n8n: { localEnabled: true, host: "http://127.0.0.1:5678" },
      }),
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => makeSidecarStub("http://127.0.0.1:5678", null),
    });

    const res = await svc.execute("wf-4");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("n8n local api key missing");
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it("local mode missing host → { ok: false, error }", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => false });

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => ({
        cloud: { enabled: false },
        n8n: { localEnabled: true },
      }),
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => null,
    });

    const res = await svc.execute("wf-5");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("n8n local host unknown");
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it("disabled mode → immediate { ok: false, error: 'n8n disabled' } without fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => false });

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => disabledConfig,
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => null,
    });

    const res = await svc.execute("wf-6");
    expect(res).toEqual({ ok: false, error: "n8n disabled" });
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it("fetch throw → { ok: false, error: 'n8n fetch failed: ...' }", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => true });

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => cloudConfig,
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => null,
    });

    const res = await svc.execute("wf-8");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("n8n fetch failed: ECONNREFUSED");
  });

  it("cloud mode missing api key → { ok: false, error } without fetch", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => true });

    const svc = createN8nDispatchService({
      runtime,
      // cloud.enabled=true but apiKey blank → resolveN8nMode returns "cloud"
      // via the isAuthenticated path; dispatch then surfaces the missing-key
      // error without hitting the network.
      getConfig: () => ({
        cloud: { enabled: true, apiKey: "   ", baseUrl: "https://x.test" },
        n8n: { localEnabled: true },
      }),
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => null,
    });

    const res = await svc.execute("wf-9");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("n8n cloud api key missing");
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });

  it("empty workflow id → { ok: false, error }", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const runtime = makeRuntime({ isAuthenticated: () => true });

    const svc = createN8nDispatchService({
      runtime,
      getConfig: () => cloudConfig,
      fetchImpl,
      isNativePlatform: () => false,
      peekSidecar: () => null,
    });

    const res = await svc.execute("   ");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("workflow id required");
    expect(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length,
    ).toBe(0);
  });
});
