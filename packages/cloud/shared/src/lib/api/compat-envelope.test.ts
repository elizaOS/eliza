// Exercises compat envelope behavior with deterministic cloud-shared lib fixtures.
import { describe, expect, test } from "bun:test";
import type { AgentSandbox } from "../../db/schemas/agent-sandboxes";
import { toCompatAgent, toCompatJob, toCompatStatus } from "./compat-envelope";

describe("toCompatStatus", () => {
  test("includes service status aliases and wallet account metadata", () => {
    const createdAt = new Date("2026-05-28T01:00:00.000Z");
    const updatedAt = new Date("2026-05-28T01:05:00.000Z");
    const sandbox = {
      id: "123e4567-e89b-12d3-a456-426614174000",
      organization_id: "org-wallet-1",
      user_id: "user-wallet-1",
      character_id: "character-1",
      sandbox_id: "sandbox-1",
      status: "running",
      bridge_url: "http://100.64.0.12:3000",
      health_url: "http://10.0.0.8:3000/health",
      agent_name: "Waifu Test",
      agent_config: {
        account: {
          primaryWalletAddress: "0x0000000000000000000000000000000000000009",
          chainType: "evm",
          elizaCloudOrganizationId: "org-wallet-1",
          elizaCloudUserId: "user-wallet-1",
        },
        container: {
          image: "ecr.test/waifu-agent:latest",
          projectName: "waifu-smoke-agent",
          port: 3000,
          memory: 1024,
          desiredCount: 1,
          architecture: "arm64",
          healthCheckPath: "/api/health",
        },
      },
      database_uri: null,
      database_status: "ready",
      database_error: null,
      snapshot_id: null,
      last_backup_at: null,
      last_heartbeat_at: updatedAt,
      error_message: null,
      error_count: 0,
      environment_vars: {},
      node_id: "node-1",
      container_name: "container-1",
      bridge_port: 3000,
      web_ui_port: 5173,
      headscale_ip: null,
      docker_image: "ecr.test/waifu-agent:latest",
      billing_status: "active",
      last_billed_at: null,
      hourly_rate: "0.0100",
      total_billed: "0.00",
      shutdown_warning_sent_at: null,
      scheduled_shutdown_at: null,
      pool_status: null,
      pool_ready_at: null,
      claimed_at: null,
      created_at: createdAt,
      updated_at: updatedAt,
    } satisfies AgentSandbox;

    const status = toCompatStatus(sandbox);
    expect(status).toMatchObject({
      agentId: "123e4567-e89b-12d3-a456-426614174000",
      cloudAgentId: "123e4567-e89b-12d3-a456-426614174000",
      containerId: "container-1",
      containerUrl: "https://123e4567-e89b-12d3-a456-426614174000.cloud.eliza.app",
      bridgeUrl: "https://123e4567-e89b-12d3-a456-426614174000.cloud.eliza.app",
      webUiUrl: "https://123e4567-e89b-12d3-a456-426614174000.cloud.eliza.app",
      status: "running",
      databaseStatus: "ready",
      account: {
        primaryWalletAddress: "0x0000000000000000000000000000000000000009",
        chainType: "evm",
        elizaCloudOrganizationId: "org-wallet-1",
        elizaCloudUserId: "user-wallet-1",
      },
      container: {
        image: "ecr.test/waifu-agent:latest",
        id: "container-1",
        nodeId: "node-1",
        bridgePort: 3000,
        webUiPort: 5173,
        projectName: "waifu-smoke-agent",
        port: 3000,
        memoryMb: 1024,
        desiredCount: 1,
        architecture: "arm64",
        healthCheckPath: "/api/health",
      },
    });
    expect(JSON.stringify(status)).not.toMatch(/100\.64|10\.0|192\.168/);

    const agent = toCompatAgent(sandbox);
    expect(agent).toMatchObject({
      headscale_ip: null,
      bridge_url: "https://123e4567-e89b-12d3-a456-426614174000.cloud.eliza.app",
      containerUrl: "https://123e4567-e89b-12d3-a456-426614174000.cloud.eliza.app",
    });
    expect(JSON.stringify(agent)).not.toMatch(/100\.64|10\.0|192\.168/);

    const job = toCompatJob(sandbox);
    expect(job.data.bridgeUrl).toBe("https://123e4567-e89b-12d3-a456-426614174000.cloud.eliza.app");
    expect(job.result).toMatchObject({
      bridgeUrl: "https://123e4567-e89b-12d3-a456-426614174000.cloud.eliza.app",
    });
    expect(JSON.stringify(job)).not.toMatch(/100\.64|10\.0|192\.168/);
  });
});
