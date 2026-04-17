import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { N8nSidecar, N8nSidecarState } from "../services/n8n-sidecar";
import {
  handleN8nStatusRoutes,
  type N8nStatusConfigLike,
} from "./n8n-status-routes";

function makeSidecarStub(state: Partial<N8nSidecarState>): N8nSidecar {
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
  } as unknown as N8nSidecar;
}

function runtimeWithCloudAuth(isAuth: boolean): AgentRuntime {
  return {
    getService: vi.fn((name: string) =>
      name === "CLOUD_AUTH" ? { isAuthenticated: () => isAuth } : null,
    ),
  } as unknown as AgentRuntime;
}

async function invoke(args: {
  method?: string;
  pathname?: string;
  config?: N8nStatusConfigLike;
  runtime?: AgentRuntime | null;
  sidecar?: N8nSidecar | null;
}): Promise<{ handled: boolean; payload: unknown }> {
  let payload: unknown = null;
  const handled = await handleN8nStatusRoutes({
    req: {} as never,
    res: {} as never,
    method: args.method ?? "GET",
    pathname: args.pathname ?? "/api/n8n/status",
    config: args.config ?? ({} as N8nStatusConfigLike),
    runtime: args.runtime ?? null,
    n8nSidecar: args.sidecar ?? null,
    json: (_res, data) => {
      payload = data;
    },
  });
  return { handled, payload };
}

describe("n8n status route", () => {
  it("ignores unrelated paths", async () => {
    const { handled } = await invoke({ pathname: "/api/cloud/status" });
    expect(handled).toBe(false);
  });

  it("ignores non-GET methods", async () => {
    const { handled } = await invoke({ method: "POST" });
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
    const sidecar = makeSidecarStub({
      status: "ready",
      host: "http://127.0.0.1:5678",
    });
    const { payload } = await invoke({
      config: { n8n: { localEnabled: true } },
      sidecar,
    });
    expect(JSON.stringify(payload)).not.toContain("SECRET");
  });
});
