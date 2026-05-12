import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

interface RunningRow {
  id: string;
  organization_id: string;
}

const state: {
  running: RunningRow[];
  heartbeatCalls: Array<{ agentId: string; orgId: string }>;
  heartbeatResults: Map<string, boolean | Error>;
} = {
  running: [],
  heartbeatCalls: [],
  heartbeatResults: new Map(),
};

mock.module("@/db/repositories/agent-sandboxes", () => ({
  agentSandboxesRepository: {
    listRunning: async (): Promise<RunningRow[]> => state.running,
  },
}));

mock.module("@/lib/services/eliza-sandbox", () => ({
  elizaSandboxService: {
    heartbeat: async (agentId: string, orgId: string): Promise<boolean> => {
      state.heartbeatCalls.push({ agentId, orgId });
      const result = state.heartbeatResults.get(agentId);
      if (result instanceof Error) throw result;
      return result ?? true;
    },
  },
}));

const { provisioningJobService } = await import("@/lib/services/provisioning-jobs");

describe("ProvisioningJobService.processRunningHeartbeats", () => {
  beforeEach(() => {
    state.running = [];
    state.heartbeatCalls = [];
    state.heartbeatResults = new Map();
  });

  afterEach(() => {
    state.running = [];
    state.heartbeatCalls = [];
    state.heartbeatResults = new Map();
  });

  test("returns zeros when no running sandboxes", async () => {
    const result = await provisioningJobService.processRunningHeartbeats();
    expect(result).toEqual({ total: 0, succeeded: 0, failed: 0 });
    expect(state.heartbeatCalls).toEqual([]);
  });

  test("calls heartbeat for every running sandbox and counts successes", async () => {
    state.running = [
      { id: "a-1", organization_id: "org-1" },
      { id: "a-2", organization_id: "org-2" },
      { id: "a-3", organization_id: "org-1" },
    ];
    state.heartbeatResults.set("a-1", true);
    state.heartbeatResults.set("a-2", true);
    state.heartbeatResults.set("a-3", true);

    const result = await provisioningJobService.processRunningHeartbeats();

    expect(result).toEqual({ total: 3, succeeded: 3, failed: 0 });
    expect(state.heartbeatCalls).toHaveLength(3);
    expect(state.heartbeatCalls.map((c) => c.agentId).sort()).toEqual(["a-1", "a-2", "a-3"]);
    expect(state.heartbeatCalls.find((c) => c.agentId === "a-2")?.orgId).toBe("org-2");
  });

  test("counts heartbeat=false as failed without crashing", async () => {
    state.running = [
      { id: "ok", organization_id: "org-1" },
      { id: "down", organization_id: "org-1" },
    ];
    state.heartbeatResults.set("ok", true);
    state.heartbeatResults.set("down", false);

    const result = await provisioningJobService.processRunningHeartbeats();

    expect(result).toEqual({ total: 2, succeeded: 1, failed: 1 });
  });

  test("treats thrown errors as failed and continues processing the rest", async () => {
    state.running = [
      { id: "boom", organization_id: "org-1" },
      { id: "ok", organization_id: "org-1" },
    ];
    state.heartbeatResults.set("boom", new Error("network down"));
    state.heartbeatResults.set("ok", true);

    const result = await provisioningJobService.processRunningHeartbeats();

    expect(result).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(state.heartbeatCalls.map((c) => c.agentId).sort()).toEqual(["boom", "ok"]);
  });

  test("respects concurrency upper bound", async () => {
    state.running = Array.from({ length: 12 }, (_, i) => ({
      id: `agent-${i}`,
      organization_id: "org-1",
    }));
    for (const r of state.running) state.heartbeatResults.set(r.id, true);

    const result = await provisioningJobService.processRunningHeartbeats(3);

    expect(result.total).toBe(12);
    expect(result.succeeded).toBe(12);
    expect(result.failed).toBe(0);
    expect(state.heartbeatCalls).toHaveLength(12);
  });
});
