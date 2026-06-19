/**
 * Agent lifecycle e2e: the suspend -> resume -> delete control loop on a single
 * `agent_sandboxes` row, exercising the real `ElizaSandboxService` orchestration
 * (provider stop, status transitions, resume idempotency + provision delegation,
 * per-agent key revocation) end to end. The piece-wise suites cover recovery,
 * lane scoping, job-type completeness and heartbeat in isolation; this walks the
 * whole state machine — running -> stopped -> running -> deleted — in one go.
 *
 * `dbWrite` is a lazy Proxy (it resolves a real connection on first method
 * access), so it can't be `spyOn`ed; the suspend/delete paths run their body
 * inside `dbWrite.transaction`. We `mock.module` the helpers barrel to swap in a
 * fake transaction backed by an in-memory row, leaving every other export
 * (dbRead, etc.) untouched — so no live Docker/Postgres is required.
 */
import { describe, expect, mock, spyOn, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import type { AgentSandbox } from "../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../db/repositories/agent-sandboxes";
import { apiKeysService } from "./api-keys";
import type { SandboxProvider } from "./sandbox-provider-types";

const ORG = "22222222-2222-4222-8222-222222222222";
const AGENT = "e06bb509-6c52-4c33-a9f7-66addc43e8c8";
const SANDBOX = "agent-e06bb509";
const BRIDGE = "https://runtime.example";

// The single mutable lifecycle row the fake transaction reads/writes. Each test
// resets `box.current` before driving the service.
const box: { current: AgentSandbox | null } = { current: null };

function renderSql(sqlObj: SQL): string {
  return new PgDialect().sqlToQuery(sqlObj).sql.toLowerCase();
}

/**
 * Answers the handful of statements the lifecycle methods issue against
 * `box.current`:
 *   advisory lock          -> no-op
 *   SELECT ... FROM "jobs"  -> no active provision job
 *   UPDATE ... 'stopped'    -> flip row to stopped, clear bridge/health
 *   DELETE ... RETURNING    -> remove + return the row
 *   SELECT ... FOR UPDATE   -> the current row (lifecycle-mutation read)
 */
const fakeTx = {
  execute: mock(async (sqlObj: SQL) => {
    const s = renderSql(sqlObj);
    if (s.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (s.includes("delete from")) {
      const removed = box.current;
      box.current = null;
      return { rows: removed ? [removed] : [] };
    }
    if (s.includes("update") && s.includes("'stopped'")) {
      if (box.current) {
        box.current = {
          ...box.current,
          status: "stopped",
          bridge_url: null,
          health_url: null,
        };
      }
      return { rows: [] };
    }
    if (s.includes('from "jobs"')) return { rows: [] };
    if (s.includes("for update")) return { rows: box.current ? [box.current] : [] };
    return { rows: [] };
  }),
};

const realHelpers = await import("../../db/helpers");
mock.module("../../db/helpers", () => ({
  ...realHelpers,
  dbWrite: {
    transaction: (cb: (tx: unknown) => unknown) => cb(fakeTx),
  },
}));

function runningAgent(): AgentSandbox {
  const now = new Date("2026-06-19T12:00:00.000Z");
  return {
    id: AGENT,
    organization_id: ORG,
    user_id: "33333333-3333-4333-8333-333333333333",
    character_id: null,
    sandbox_id: SANDBOX,
    status: "running",
    execution_tier: "dedicated",
    bridge_url: BRIDGE,
    health_url: `${BRIDGE}/health`,
    agent_name: "lifecycle-nancy",
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
    container_name: SANDBOX,
    bridge_port: 18923,
    web_ui_port: 23816,
    headscale_ip: "100.64.0.10",
    docker_image: "ghcr.io/example/nancy:latest",
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

function fakeProvider() {
  const provider: SandboxProvider = {
    create: mock(async () => ({
      sandboxId: SANDBOX,
      bridgeUrl: BRIDGE,
      healthUrl: `${BRIDGE}/health`,
      metadata: { nodeId: "node-1", containerName: SANDBOX },
    })),
    stop: mock(async () => {}),
    checkHealth: mock(async () => true),
  };
  return provider;
}

describe("agent lifecycle: suspend -> resume -> delete", () => {
  test("walks running -> stopped -> running -> deleted with the right provider + key calls", async () => {
    box.current = runningAgent();
    fakeTx.execute.mockClear();
    const provider = fakeProvider();
    const stopMock = provider.stop as ReturnType<typeof mock>;
    const { ElizaSandboxService } = await import("./eliza-sandbox");
    const svc = new ElizaSandboxService(provider);

    const findSpy = spyOn(agentSandboxesRepository, "findByIdAndOrg").mockImplementation(
      async () => box.current ?? undefined,
    );
    const revokeSpy = spyOn(apiKeysService, "revokeForAgent").mockResolvedValue(
      undefined as never,
    );

    try {
      // 1) SUSPEND: running -> stopped. Container stopped, bridge/health cleared
      //    so the router stops dialing the agent.
      const suspend = await svc.executeSuspend(AGENT, ORG);
      expect(suspend.success).toBe(true);
      expect(suspend.containerStopped).toBe(true);
      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(stopMock).toHaveBeenLastCalledWith(SANDBOX);
      expect(box.current?.status).toBe("stopped");
      expect(box.current?.bridge_url).toBeNull();

      // 2) RESUME from stopped: the only path that restores bridge_url today is
      //    provision(); executeResume must delegate to it.
      const provisionSpy = spyOn(svc, "provision").mockImplementation(async () => {
        if (box.current) {
          box.current = { ...box.current, status: "running", bridge_url: BRIDGE };
        }
        return { success: true } as never;
      });
      const resume = await svc.executeResume(AGENT, ORG);
      expect(resume.success).toBe(true);
      expect(resume.reprovisioned).toBe(true);
      expect(provisionSpy).toHaveBeenCalledTimes(1);
      expect(box.current?.status).toBe("running");

      // 3) RESUME idempotency: an already-running agent is NOT re-provisioned.
      provisionSpy.mockClear();
      const resumeNoop = await svc.executeResume(AGENT, ORG);
      expect(resumeNoop.success).toBe(true);
      expect(resumeNoop.reprovisioned).toBe(false);
      expect(provisionSpy).not.toHaveBeenCalled();

      // 4) DELETE: container stopped, row removed, per-agent API key revoked.
      const del = await svc.deleteAgent(AGENT, ORG);
      expect(del.success).toBe(true);
      expect(stopMock).toHaveBeenCalledTimes(2); // suspend + delete
      expect(box.current).toBeNull();
      expect(revokeSpy).toHaveBeenCalledWith(AGENT);
    } finally {
      findSpy.mockRestore();
      revokeSpy.mockRestore();
    }
  });

  test("suspend is idempotent: an already-stopped agent does not re-stop the container", async () => {
    box.current = { ...runningAgent(), status: "stopped" };
    const provider = fakeProvider();
    const stopMock = provider.stop as ReturnType<typeof mock>;
    const { ElizaSandboxService } = await import("./eliza-sandbox");
    const svc = new ElizaSandboxService(provider);

    const suspend = await svc.executeSuspend(AGENT, ORG);
    expect(suspend.success).toBe(true);
    expect(suspend.containerStopped).toBe(true);
    expect(stopMock).not.toHaveBeenCalled();
  });
});
