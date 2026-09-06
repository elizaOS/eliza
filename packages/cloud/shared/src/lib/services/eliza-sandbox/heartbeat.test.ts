/** Exercises sandbox heartbeat contracts with explicit database and replacement-authority simulations. Real durable authority is covered separately by the PGlite suites. */
import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import type { AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import { agentSandboxesRepository } from "../../../db/repositories/agent-sandboxes";
import { dockerNodesRepository } from "../../../db/repositories/docker-nodes";
import { provisioningJobService } from "../provisioning-jobs";
import {
  installSandboxBillingSimulation,
  installSandboxDatabaseSimulation,
} from "./test-support/database.js";
import { customSandbox } from "./test-support/fixtures.js";
import { installReplacementLifecycleSimulation } from "./test-support/replacement.js";

const originalFetch = globalThis.fetch;
const originalWebSocketPair = Object.getOwnPropertyDescriptor(globalThis, "WebSocketPair");
function restoreWebSocketPair() {
  if (originalWebSocketPair)
    Object.defineProperty(globalThis, "WebSocketPair", originalWebSocketPair);
  else Reflect.deleteProperty(globalThis, "WebSocketPair");
}
afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreWebSocketPair();
});

let restoreDatabase: (() => void) | undefined;
let restoreReplacement: (() => void) | undefined;
let billing: ReturnType<typeof installSandboxBillingSimulation>;
beforeAll(async () => {
  restoreDatabase = installSandboxDatabaseSimulation();
  restoreReplacement = await installReplacementLifecycleSimulation();
  billing = installSandboxBillingSimulation();
});
afterAll(() => {
  billing.restore();
  restoreReplacement?.();
  restoreDatabase?.();
});
describe("ElizaSandboxService heartbeat", () => {
  // Pins the behaviour the probeBridgeHealth() extraction must preserve on the
  // prod-critical heartbeat path: grace-window hysteresis and the exact DB
  // writes. A regression here flips healthy agents to disconnected (the bug the
  // bridge-port fix already cost us once).

  test("probe miss inside the grace window keeps the agent running with no DB write", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    // last_heartbeat_at 30s ago < 120s grace → stay running.
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      last_heartbeat_at: new Date(Date.now() - 30_000),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async () => undefined as never,
    );
    globalThis.fetch = mock(async () => {
      throw new Error("fetch failed");
    });

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  test("probe miss past the grace window marks disconnected without bumping heartbeat", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    // last_heartbeat_at 200s ago > 120s grace → disconnect.
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      last_heartbeat_at: new Date(Date.now() - 200_000),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
    );
    const nodeSpy = spyOn(dockerNodesRepository, "findByNodeId").mockResolvedValue(undefined);
    globalThis.fetch = mock(async () => {
      throw new Error("fetch failed");
    });

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("disconnected");
      // last_heartbeat_at is bumped ONLY on success — its age is the liveness clock.
      expect(Object.hasOwn(patch, "last_heartbeat_at")).toBe(false);
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      nodeSpy.mockRestore();
    }
  });

  test("probe that succeeds on a retry bumps last_heartbeat_at and leaves status alone", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
    );
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) throw new Error("cold path"); // first attempt re-warms
      return new Response("ok", { status: 200 });
    });

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(true);
      expect(calls).toBe(2); // retry semantics preserved
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.last_heartbeat_at).toBeInstanceOf(Date);
      expect(patch.status).toBeUndefined();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  test("a successful probe cannot write through a concurrent delete intent", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(undefined);
    globalThis.fetch = mock(async () => new Response("ok", { status: 200 }));

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [id, patch, expectedGeneration] = updateSpy.mock.calls[0];
      expect(id).toBe(sandbox.id);
      expect(patch.last_heartbeat_at).toBeInstanceOf(Date);
      expect(expectedGeneration).toEqual({
        organizationId: sandbox.organization_id,
        environmentRevision: sandbox.environment_revision,
        sandboxId: sandbox.sandbox_id,
        nodeId: sandbox.node_id,
        containerName: sandbox.container_name,
        lifecycleRevision: sandbox.lifecycle_revision,
      });
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
    }
  });

  test("terminal database liveness failure enqueues a bounded restart", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-db-liveness-restart" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          status: "unhealthy",
          database: "terminal_error",
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.error_count).toBe(1);
      expect(String(patch.error_message)).toContain("[db-liveness-restart]");
      expect(enqueueSpy).toHaveBeenCalledWith({
        agentId: sandbox.id,
        organizationId: sandbox.organization_id,
        userId: sandbox.user_id,
      });
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("a terminal probe cannot enqueue recovery after concurrent deletion takes ownership", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox = customSandbox();
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockResolvedValue(
      sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockResolvedValue(undefined);
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockResolvedValue({
      created: true,
      job: { id: "job-must-not-start" },
    } as never);
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      await expect(
        new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id),
      ).resolves.toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("transient database liveness failures do not enqueue an immediate restart", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      last_heartbeat_at: new Date(Date.now() - 30_000),
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async () => undefined as never,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-should-not-start" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json({
        status: "healthy",
        database: "transient_error",
        databaseLiveness: {
          ok: false,
          status: "transient_error",
          terminal: false,
          message: "temporary probe timeout",
        },
      }),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).not.toHaveBeenCalled();
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("unrelated error_count does not consume the database-liveness restart budget", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      error_count: 9,
      error_message: "tailnet reconciliation failures",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (_id, updates) => ({ ...sandbox, ...updates }) as AgentSandbox,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-db-budget-isolated" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.error_count).toBe(1);
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("database-liveness restart cooldown suppresses duplicate enqueue", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      error_count: 1,
      error_message: `[db-liveness-restart] count=1 at=${new Date().toISOString()} reason=PGlite is closed`,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async () => undefined as never,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-duplicate" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "Database is shutting down - operation rejected",
          },
        },
        { status: 503 },
      ),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).not.toHaveBeenCalled();
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("database-liveness restart budget exhausts to error instead of looping", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const sandbox: AgentSandbox = {
      ...customSandbox(),
      error_count: 3,
      error_message: `[db-liveness-restart] count=3 at=${new Date(Date.now() - 20 * 60_000).toISOString()} reason=PGlite is closed`,
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async () => sandbox,
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async () => undefined as never,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-budget-exhausted" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      const ok = await new ElizaSandboxService().heartbeat(sandbox.id, sandbox.organization_id);
      expect(ok).toBe(false);
      expect(updateSpy).toHaveBeenCalledTimes(1);
      const [, patch] = updateSpy.mock.calls[0] as [string, Record<string, unknown>];
      expect(patch.status).toBe("error");
      expect(patch.error_count).toBe(3);
      expect(String(patch.error_message)).toContain("budget-exhausted");
      expect(enqueueSpy).not.toHaveBeenCalled();
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });

  test("database-liveness restart budget is isolated per agent record", async () => {
    const { ElizaSandboxService } = await import("../eliza-sandbox.ts?actual");
    const exhausted: AgentSandbox = {
      ...customSandbox(),
      id: "11111111-1111-4111-8111-111111111111",
      error_count: 3,
      error_message: `[db-liveness-restart] count=3 at=${new Date(Date.now() - 20 * 60_000).toISOString()} reason=PGlite is closed`,
    };
    const fresh: AgentSandbox = {
      ...customSandbox(),
      id: "22222222-2222-4222-8222-222222222222",
      error_count: 3,
      error_message: "unrelated launch failures",
    };
    const findSpy = spyOn(agentSandboxesRepository, "findRunningSandbox").mockImplementation(
      async (agentId) => (agentId === exhausted.id ? exhausted : fresh),
    );
    const updateSpy = spyOn(agentSandboxesRepository, "update").mockImplementation(
      async (agentId, updates) =>
        ({
          ...(agentId === exhausted.id ? exhausted : fresh),
          ...updates,
        }) as AgentSandbox,
    );
    const enqueueSpy = spyOn(provisioningJobService, "enqueueAgentRestartOnce").mockImplementation(
      async () =>
        ({
          created: true,
          job: { id: "job-agent-isolated" },
        }) as never,
    );
    globalThis.fetch = mock(async () =>
      Response.json(
        {
          databaseLiveness: {
            ok: false,
            status: "terminal_error",
            terminal: true,
            message: "PGlite is closed",
          },
        },
        { status: 503 },
      ),
    );

    try {
      await expect(
        new ElizaSandboxService().heartbeat(exhausted.id, exhausted.organization_id),
      ).resolves.toBe(false);
      await expect(
        new ElizaSandboxService().heartbeat(fresh.id, fresh.organization_id),
      ).resolves.toBe(false);

      expect(updateSpy).toHaveBeenCalledTimes(2);
      expect(updateSpy.mock.calls[0][1]).toMatchObject({
        status: "error",
        error_count: 3,
      });
      expect(updateSpy.mock.calls[1][1]).toMatchObject({
        error_count: 1,
      });
      expect(enqueueSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith({
        agentId: fresh.id,
        organizationId: fresh.organization_id,
        userId: fresh.user_id,
      });
    } finally {
      findSpy.mockRestore();
      updateSpy.mockRestore();
      enqueueSpy.mockRestore();
    }
  });
});
