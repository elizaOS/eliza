/**
 * Unit tests for compat-envelope field mapping layer.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentSandbox } from "../../db/schemas/agent-sandboxes";
import {
  envelope,
  errorEnvelope,
  mapStatus,
  toCompatAgent,
  toCompatCreateResult,
  toCompatJob,
  toCompatOpResult,
  toCompatStatus,
  toCompatUsage,
} from "../../lib/api/compat-envelope";

const savedAgentBaseDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;

beforeEach(() => {
  process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "shad0w.xyz";
});

afterEach(() => {
  if (savedAgentBaseDomain === undefined) {
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
  } else {
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = savedAgentBaseDomain;
  }
});

function makeSandbox(overrides: Partial<AgentSandbox> = {}): AgentSandbox {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    organization_id: "org-1",
    user_id: "user-1",
    character_id: null,
    sandbox_id: "agent-aaaaaaaa",
    status: "running",
    bridge_url: "http://10.0.0.5:18800",
    health_url: "http://10.0.0.5:20100",
    agent_name: "TestAgent",
    agent_config: { models: { small: "gpt-5.4-mini" } },
    neon_project_id: "proj-1",
    neon_branch_id: "br-1",
    database_uri: "postgres://...",
    database_status: "ready",
    database_error: null,
    snapshot_id: null,
    last_backup_at: null,
    last_billed_at: null,
    last_heartbeat_at: new Date("2026-03-09T12:00:00Z"),
    error_message: null,
    error_count: 0,
    environment_vars: {},
    node_id: "agent-node-1",
    container_name: "agent-aaaaaaaa",
    bridge_port: 18800,
    web_ui_port: 20100,
    headscale_ip: "100.64.0.5",
    docker_image: "agent/agent:cloud-full-ui",
    billing_status: "active",
    hourly_rate: "0.0100",
    total_billed: "0.00",
    shutdown_warning_sent_at: null,
    scheduled_shutdown_at: null,
    pool_status: null,
    pool_ready_at: null,
    claimed_at: null,
    created_at: new Date("2026-03-09T10:00:00Z"),
    updated_at: new Date("2026-03-09T11:00:00Z"),
    ...overrides,
  };
}

describe("toCompatAgent", () => {
  test("maps running sandbox to eliza-cloud Agent shape", () => {
    const agent = toCompatAgent(makeSandbox());
    expect(agent.agent_id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(agent.agent_name).toBe("TestAgent");
    expect(agent.node_id).toBe("agent-node-1");
    expect(agent.container_id).toBe("agent-aaaaaaaa");
    expect(agent.headscale_ip).toBe("100.64.0.5");
    expect(agent.bridge_url).toBe("http://10.0.0.5:18800");
    expect(agent.status).toBe("running");
    expect(agent.agent_config).toEqual({ models: { small: "gpt-5.4-mini" } });
    expect(agent.created_at).toBe("2026-03-09T10:00:00.000Z");
    expect(agent.updated_at).toBe("2026-03-09T11:00:00.000Z");
    expect(agent.last_heartbeat_at).toBe("2026-03-09T12:00:00.000Z");
    expect(agent.containerUrl).toBe("http://10.0.0.5:18800");
    expect(agent.webUiUrl).toBe("https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.shad0w.xyz");
  });

  test("maps pending status to queued", () => {
    expect(toCompatAgent(makeSandbox({ status: "pending" })).status).toBe("queued");
  });

  test("maps error status to failed", () => {
    expect(toCompatAgent(makeSandbox({ status: "error" })).status).toBe("failed");
  });

  test("maps disconnected status to stopped", () => {
    expect(toCompatAgent(makeSandbox({ status: "disconnected" })).status).toBe("stopped");
  });

  test("uses sandbox_id as container_id fallback", () => {
    const agent = toCompatAgent(makeSandbox({ container_name: null, sandbox_id: "docker-123" }));
    expect(agent.container_id).toBe("docker-123");
  });

  test("web_ui_url uses public domain route when headscale_ip is null", () => {
    const agent = toCompatAgent(makeSandbox({ headscale_ip: null }));
    expect(agent.web_ui_url).toBe("https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.shad0w.xyz");
    expect(agent.webUiUrl).toBe("https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.shad0w.xyz");
  });

  test("uses configurable agent base domain for web UI links", () => {
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "agents.example.com";
    const agent = toCompatAgent(makeSandbox());
    expect(agent.webUiUrl).toBe("https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.agents.example.com");
  });

  test("falls back to waifu.fun when agent base domain is unset", () => {
    delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
    const agent = toCompatAgent(makeSandbox());
    expect(agent.web_ui_url).toBe("https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.waifu.fun");
  });

  test("last_heartbeat_at is null when never heartbeated", () => {
    expect(toCompatAgent(makeSandbox({ last_heartbeat_at: null })).last_heartbeat_at).toBeNull();
  });
});

describe("toCompatCreateResult", () => {
  test("returns expected shape for pending agent", () => {
    const result = toCompatCreateResult(makeSandbox({ status: "pending" }));
    expect(result.agentId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result.agentName).toBe("TestAgent");
    expect(result.jobId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(result.status).toBe("queued");
    expect(result.nodeId).toBe("agent-node-1");
    expect(result.message).toContain("poll");
  });

  test("message reflects running status", () => {
    const result = toCompatCreateResult(makeSandbox({ status: "running" }));
    expect(result.status).toBe("running");
    expect(result.message).toContain("running");
  });

  test("reuses the agent ID as the compat job ID", () => {
    const sandbox = makeSandbox({ status: "pending" });
    const result = toCompatCreateResult(sandbox);
    const job = toCompatJob(sandbox);

    expect(result.jobId).toBe(sandbox.id);
    expect(job.jobId).toBe(sandbox.id);
    expect(job.id).toBe(sandbox.id);
  });
});

describe("toCompatOpResult", () => {
  test("returns completed for success", () => {
    const result = toCompatOpResult("agent-1", "restart", true);
    expect(result.jobId).toBe("agent-1");
    expect(result.status).toBe("completed");
    expect(result.message).toContain("restart completed");
  });

  test("returns failed for failure", () => {
    const result = toCompatOpResult("agent-1", "delete", false);
    expect(result.status).toBe("failed");
    expect(result.message).toContain("delete failed");
  });
});

describe("toCompatJob", () => {
  test("maps running sandbox to completed job", () => {
    const job = toCompatJob(makeSandbox({ status: "running" }));
    expect(job.jobId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(job.type).toBe("create-agent");
    expect(job.status).toBe("completed");
    expect(job.result).toEqual(
      expect.objectContaining({
        agentId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        bridgeUrl: "http://10.0.0.5:18800",
      }),
    );
    expect(job.error).toBeNull();
    expect(job.completedAt).toBeTruthy();
    expect(job.retryCount).toBe(0);
    expect(job.id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(job.name).toBe("provision");
    expect(job.state).toBe("completed");
    expect(job.completed_on).toBeTruthy();
  });

  test("maps pending sandbox to queued job", () => {
    const job = toCompatJob(makeSandbox({ status: "pending" }));
    expect(job.status).toBe("queued");
    expect(job.state).toBe("waiting");
    expect(job.result).toBeNull();
    expect(job.startedAt).toBeNull();
    expect(job.completedAt).toBeNull();
  });

  test("maps provisioning sandbox to processing job", () => {
    const job = toCompatJob(makeSandbox({ status: "provisioning" }));
    expect(job.status).toBe("processing");
    expect(job.state).toBe("active");
    expect(job.startedAt).toBeTruthy();
  });

  test("maps disconnected sandbox to completed job", () => {
    const job = toCompatJob(makeSandbox({ status: "disconnected" }));
    expect(job.jobId).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(job.id).toBe("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(job.status).toBe("completed");
    expect(job.state).toBe("completed");
    expect(job.completedAt).toBeTruthy();
  });

  test("maps error sandbox to failed job", () => {
    const job = toCompatJob(
      makeSandbox({
        status: "error",
        error_message: "Container health check timed out",
        error_count: 3,
      }),
    );
    expect(job.status).toBe("failed");
    expect(job.state).toBe("failed");
    expect(job.error).toBe("Container health check timed out");
    expect(job.retryCount).toBe(3);
  });

  test("maps disconnected sandbox to completed job with stopped compat status", () => {
    const job = toCompatJob(makeSandbox({ status: "disconnected" }));
    expect(job.status).toBe("completed");
    expect(job.state).toBe("completed");
    expect(job.data.status).toBe("stopped");
    expect(job.result).toEqual(expect.objectContaining({ status: "stopped" }));
  });
});

describe("toCompatStatus", () => {
  test("maps running sandbox to status shape", () => {
    const status = toCompatStatus(makeSandbox());
    expect(status.status).toBe("running");
    expect(status.lastHeartbeat).toBe("2026-03-09T12:00:00.000Z");
    expect(status.bridgeUrl).toBe("http://10.0.0.5:18800");
    expect(status.webUiUrl).toBe("https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.shad0w.xyz");
    expect(status.currentNode).toBe("agent-node-1");
    expect(status.suspendedReason).toBeNull();
    expect(status.databaseStatus).toBe("ready");
  });

  test("includes error message as suspendedReason", () => {
    const status = toCompatStatus(makeSandbox({ status: "error", error_message: "OOM killed" }));
    expect(status.status).toBe("failed");
    expect(status.suspendedReason).toBe("OOM killed");
  });

  test("webUiUrl uses public domain route when no headscale_ip", () => {
    expect(toCompatStatus(makeSandbox({ headscale_ip: null })).webUiUrl).toBe(
      "https://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.shad0w.xyz",
    );
  });
});

describe("toCompatUsage", () => {
  test("returns zero usage for stopped agent", () => {
    const usage = toCompatUsage(makeSandbox({ status: "stopped" }));
    expect(usage.uptimeHours).toBe(0);
    expect(usage.status).toBe("stopped");
    expect(usage.estimatedDailyBurnUsd).toBe(0);
    expect(usage.currentPeriodCostUsd).toBe(0);
  });

  test("returns non-zero uptime for running agent", () => {
    const usage = toCompatUsage(
      makeSandbox({
        status: "running",
        created_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
      }),
    );
    expect(usage.uptimeHours).toBeGreaterThan(1.9);
    expect(usage.uptimeHours).toBeLessThan(2.1);
    expect(usage.status).toBe("running");
  });

  test("extracts funding source from agent_config", () => {
    const usage = toCompatUsage(
      makeSandbox({
        agent_config: { billing: { mode: "waifu_treasury_subsidy" } },
      }),
    );
    expect(usage.fundingSource).toBe("waifu_treasury_subsidy");
  });

  test("defaults funding source to unknown", () => {
    expect(toCompatUsage(makeSandbox({ agent_config: {} })).fundingSource).toBe("unknown");
  });
});

describe("mapStatus", () => {
  test("pending -> queued", () => expect(mapStatus("pending")).toBe("queued"));
  test("provisioning -> provisioning", () =>
    expect(mapStatus("provisioning")).toBe("provisioning"));
  test("running -> running", () => expect(mapStatus("running")).toBe("running"));
  test("stopped -> stopped", () => expect(mapStatus("stopped")).toBe("stopped"));
  test("disconnected -> stopped", () => expect(mapStatus("disconnected")).toBe("stopped"));
  test("error -> failed", () => expect(mapStatus("error")).toBe("failed"));
});

describe("envelope", () => {
  test("wraps data in success envelope", () => {
    expect(envelope({ foo: "bar" })).toEqual({
      success: true,
      data: { foo: "bar" },
    });
  });
});

describe("errorEnvelope", () => {
  test("wraps message in error envelope", () => {
    expect(errorEnvelope("oops")).toEqual({ success: false, error: "oops" });
  });
});
