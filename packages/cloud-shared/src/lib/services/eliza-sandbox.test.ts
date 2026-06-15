import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";

import type { AgentSandbox, AgentSandboxBackup } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { cache } from "../cache/client";
import { runWithCloudBindings } from "../runtime/cloud-bindings";
import { apiKeysService } from "./api-keys";
import { resolveSandboxContainerLaunchConfig } from "./sandbox-container-launch-config";
import type { SandboxProvider } from "./sandbox-provider-types";

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

function sharedSandbox(): AgentSandbox {
  return {
    ...customSandbox(),
    sandbox_id: null,
    execution_tier: "shared",
    bridge_url: null,
    health_url: null,
    agent_name: "shared-nancy",
    agent_config: { system: "You are shared-nancy." },
    environment_vars: {},
    node_id: null,
    container_name: null,
    bridge_port: null,
    web_ui_port: null,
    headscale_ip: null,
    docker_image: null,
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
          chat: true,
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

describe("ElizaSandboxService shared runtime bridge", () => {
  test("does not persist degraded shared-runtime turns", async () => {
    const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
    const sandbox = sharedSandbox();
    const findRunningSandboxSpy = spyOn(
      agentSandboxesRepository,
      "findRunningSandbox",
    ).mockResolvedValue(sandbox);
    const cacheGetSpy = spyOn(cache, "get").mockResolvedValue([]);
    const cacheSetSpy = spyOn(cache, "set").mockResolvedValue(undefined);

    try {
      const response = await runWithCloudBindings(
        {
          CEREBRAS_API_KEY: "",
          OPENAI_API_KEY: "",
        },
        () =>
          new ElizaSandboxService().bridge(sandbox.id, sandbox.organization_id, {
            jsonrpc: "2.0",
            id: "shared-turn",
            method: "message.send",
            params: { text: "hello" },
          }),
      );

      expect(response).toEqual({
        jsonrpc: "2.0",
        id: "shared-turn",
        result: {
          text: "shared-nancy is temporarily unavailable (no shared model configured).",
          agentName: "shared-nancy",
          channelId: expect.any(String),
          model: "none",
          degraded: true,
          runtime: "shared",
        },
      });
      expect(cacheGetSpy).toHaveBeenCalled();
      expect(cacheSetSpy).not.toHaveBeenCalled();
    } finally {
      findRunningSandboxSpy.mockRestore();
      cacheGetSpy.mockRestore();
      cacheSetSpy.mockRestore();
    }
  });
});

describe("ElizaSandboxService wake", () => {
  test.skipIf(process.platform === "win32")(
    "skips missing state restore endpoint for web-only custom images",
    async () => {
      const { ElizaSandboxService } = await import("./eliza-sandbox.ts?actual");
      const now = new Date("2026-06-04T12:05:00.000Z");
      const sleepingSandbox: AgentSandbox = {
        ...customSandbox(),
        status: "sleeping",
        sandbox_id: null,
        bridge_url: null,
        health_url: null,
        node_id: null,
        container_name: null,
        bridge_port: null,
        web_ui_port: null,
        headscale_ip: null,
        updated_at: now,
      };
      const backup: AgentSandboxBackup = {
        id: "11111111-1111-4111-8111-111111111111",
        sandbox_record_id: sleepingSandbox.id,
        snapshot_type: "pre-shutdown",
        state_data: { memories: [], config: {}, workspaceFiles: {} },
        state_data_storage: "inline",
        state_data_key: null,
        size_bytes: 2,
        backup_kind: "full",
        parent_backup_id: null,
        content_hash: null,
        created_at: now,
      };
      const provider: SandboxProvider = {
        create: mock(async () => ({
          sandboxId: "agent-e06bb509",
          bridgeUrl: "https://runtime.example",
          healthUrl: "https://runtime.example/health",
          metadata: {
            nodeId: "node-1",
            containerName: "agent-e06bb509",
            bridgePort: 21060,
            webUiPort: 3000,
          },
        })),
        stop: mock(async () => {}),
        checkHealth: mock(async () => true),
      };
      const requests: string[] = [];
      globalThis.fetch = mock(async (input: RequestInfo | URL) => {
        const url = fetchUrl(input);
        requests.push(url);
        if (url === "https://runtime.example/api/agents") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        if (url === "https://runtime.example/api/restore") {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        return Response.json({ ok: true });
      });
      const originalFindByIdAndOrg = agentSandboxesRepository.findByIdAndOrg;
      const originalTrySetProvisioning = agentSandboxesRepository.trySetProvisioning;
      const originalGetLatestBackup = agentSandboxesRepository.getLatestBackup;
      const originalGetReconstructedBackupState =
        agentSandboxesRepository.getReconstructedBackupState;
      agentSandboxesRepository.findByIdAndOrg = mock(async () => sleepingSandbox);
      agentSandboxesRepository.trySetProvisioning = mock(async () => ({
        ...sleepingSandbox,
        status: "provisioning",
      }));
      agentSandboxesRepository.getLatestBackup = mock(async () => backup);
      agentSandboxesRepository.getReconstructedBackupState = mock(async () => ({
        memories: [],
        config: {},
        workspaceFiles: {},
      }));
      const createForAgentSpy = spyOn(apiKeysService, "createForAgent").mockResolvedValue({
        id: "22222222-2222-4222-8222-222222222222",
        plainKey: "eliza_test_agent_key",
        prefix: "eliza_test",
      });
      const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
        async (_id, data) => ({
          ...sleepingSandbox,
          ...data,
          updated_at: now,
        }),
      );

      try {
        const result = await new ElizaSandboxService(provider).executeWake(
          sleepingSandbox.id,
          sleepingSandbox.organization_id,
        );

        expect(result).toEqual({
          success: true,
          reprovisioned: true,
          restoredBackupId: backup.id,
        });
        expect(requests).toContain("https://runtime.example/api/restore");
        expect(updateSpy).toHaveBeenCalledWith(
          sleepingSandbox.id,
          expect.objectContaining({ status: "running" }),
        );
      } finally {
        agentSandboxesRepository.findByIdAndOrg = originalFindByIdAndOrg;
        agentSandboxesRepository.trySetProvisioning = originalTrySetProvisioning;
        agentSandboxesRepository.getLatestBackup = originalGetLatestBackup;
        agentSandboxesRepository.getReconstructedBackupState = originalGetReconstructedBackupState;
        createForAgentSpy.mockRestore();
        updateSpy.mockRestore();
      }
    },
  );
});
