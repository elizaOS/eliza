import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { resolveSandboxContainerLaunchConfig } from "./sandbox-container-launch-config";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");

function restoreWebSocketPair(): void {
  if (originalWebSocketPair) {
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
    return;
  }
  Reflect.deleteProperty(globalThis, "WebSocketPair");
}

function fetchUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function fetchHeaders(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

function customSandbox(): AgentSandbox {
  const now = new Date("2026-06-04T12:00:00.000Z");
  return {
    id: "e06bb509-6c52-4c33-a9f7-66addc43e8c8",
    organization_id: "22222222-2222-4222-8222-222222222222",
    user_id: "33333333-3333-4333-8333-333333333333",
    character_id: null,
    sandbox_id: "sandbox-e06bb509",
    status: "running",
    execution_tier: "custom",
    bridge_url: "https://legacy-bridge.example",
    health_url: "https://legacy-bridge.example/health",
    agent_name: "bnancy",
    agent_config: {},
    neon_project_id: null,
    neon_branch_id: null,
    database_uri: "postgres://agent-db.example",
    database_status: "ready",
    database_error: null,
    snapshot_id: null,
    last_backup_at: null,
    last_heartbeat_at: null,
    error_message: null,
    error_count: 0,
    environment_vars: { ELIZA_API_TOKEN: "agent-token" },
    node_id: "node-1",
    container_name: "agent-e06bb509",
    bridge_port: 18923,
    web_ui_port: 23816,
    headscale_ip: "100.64.0.10",
    docker_image: "ghcr.io/example/bnancy:latest",
    image_digest: null,
    billing_status: "active",
    last_billed_at: null,
    hourly_rate: "0.0100",
    total_billed: "0.00",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    pool_status: null,
    pool_ready_at: null,
    claimed_at: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});

describe("resolveSandboxContainerLaunchConfig", () => {
  test("maps stored waifu container hints to sandbox provider launch config", () => {
    expect(
      resolveSandboxContainerLaunchConfig({
        container: {
          projectName: "waifu-smoke-agent",
          port: 3000,
          cpu: 512,
          memory: 1024,
          desiredCount: 1,
          architecture: "arm64",
          healthCheckPath: "/api/health",
        },
      }),
    ).toEqual({
      projectName: "waifu-smoke-agent",
      port: 3000,
      cpu: 512,
      memoryMb: 1024,
      desiredCount: 1,
      architecture: "arm64",
      healthCheckPath: "/api/health",
    });
  });

  test("ignores invalid or absent container hints", () => {
    expect(
      resolveSandboxContainerLaunchConfig({
        container: {
          projectName: "",
          port: 0,
          cpu: -1,
          memory: Number.NaN,
          desiredCount: 1.5,
          architecture: "riscv64",
          healthCheckPath: "",
        },
      }),
    ).toBeUndefined();
    expect(resolveSandboxContainerLaunchConfig({})).toBeUndefined();
  });
});

describe("ElizaSandboxService bridge status", () => {
  test("reports web-only custom agents as running through the router origin in Workers", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox);
    Object.defineProperty(globalThis, "WebSocketPair", {
      value: class WebSocketPair {},
      configurable: true,
    });
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = fetchUrl(input);
      requests.push({ url, headers: fetchHeaders(init?.headers) });
      if (url === `https://${sandbox.id}.elizacloud.ai/api/agents`) {
        return new Response("{}", { status: 404 });
      }
      if (url === "https://eliza-production-1.elizacloud.ai/") {
        return new Response("<!doctype html>", { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    try {
      const response = await runWithCloudBindings(
        {
          ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
          AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
        },
        () =>
          new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
            jsonrpc: "2.0",
            id: "status-check",
            method: "status.get",
            params: {},
          }),
      );

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: "status-check",
        result: {
          status: "running",
          ready: true,
          agentId: sandbox.id,
          runtime: "web",
          chat: false,
        },
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]?.url.startsWith(`https://${sandbox.id}.elizacloud.ai`)).toBe(true);
      expect(requests[1]).toEqual({
        url: "https://eliza-production-1.elizacloud.ai/",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer agent-token",
          "X-Api-Key": "agent-token",
          "X-Eliza-Token": "agent-token",
          "x-forwarded-host": `${sandbox.id}.elizacloud.ai`,
          "x-forwarded-proto": "https",
        },
      });
    } finally {
      findRunningSandboxSpy.mockRestore();
    }
  });
});
