/**
 * Real tests for sub-agent NESTING via the parent-agent broker's new
 * `spawn-sub-agent` mode: a running sub-agent spawns its own child on the same
 * task through the EXISTING spawn path (no new API). Verifies depth computation,
 * the required-field guards, and that a spawn error (e.g. the depth cap) is
 * surfaced back to the child as text rather than thrown.
 */

import { describe, expect, it, vi } from "vitest";
import { runParentAgentBroker } from "../services/parent-agent-broker";

type SpawnFn = (
  taskId: string,
  opts: Record<string, unknown>,
) => Promise<unknown>;

function makeRequest(args: {
  service: { spawnAgentForTask: SpawnFn } | null;
  sessionMetadata: Record<string, unknown> | undefined;
  brokerArgs: Record<string, unknown>;
}) {
  const runtime = {
    getService: (name: string) =>
      name === "ORCHESTRATOR_TASK_SERVICE" ? args.service : null,
    logger: {
      info() {},
      warn() {},
      error() {},
      debug() {},
      success() {},
    },
  };
  return {
    runtime: runtime as never,
    sessionId: "sess-1",
    session: { metadata: args.sessionMetadata } as never,
    args: args.brokerArgs,
  };
}

describe("parent-agent broker — spawn-sub-agent (nesting)", () => {
  it("spawns a child for the parent task at parent depth + 1", async () => {
    const spawnAgentForTask = vi.fn<SpawnFn>(async () => ({
      task: { id: "task-1" },
    }));
    const res = await runParentAgentBroker(
      makeRequest({
        service: { spawnAgentForTask },
        sessionMetadata: { taskId: "task-1", nestingDepth: 0 },
        brokerArgs: {
          mode: "spawn-sub-agent",
          task: "write tests",
          label: "tester",
        },
      }),
    );
    expect(res.success).toBe(true);
    expect(spawnAgentForTask).toHaveBeenCalledTimes(1);
    const [taskId, opts] = spawnAgentForTask.mock.calls[0];
    expect(taskId).toBe("task-1");
    expect(opts).toMatchObject({
      task: "write tests",
      label: "tester",
      nestingDepth: 1,
    });
  });

  it("computes child depth from the parent session's nestingDepth", async () => {
    const spawnAgentForTask = vi.fn<SpawnFn>(async () => ({}));
    await runParentAgentBroker(
      makeRequest({
        service: { spawnAgentForTask },
        sessionMetadata: { taskId: "t", nestingDepth: 2 },
        brokerArgs: { mode: "spawn-sub-agent", task: "x" },
      }),
    );
    expect(spawnAgentForTask.mock.calls[0][1]).toMatchObject({
      nestingDepth: 3,
    });
  });

  it("refuses (no spawn) when the session has no taskId", async () => {
    const spawnAgentForTask = vi.fn<SpawnFn>(async () => ({}));
    const res = await runParentAgentBroker(
      makeRequest({
        service: { spawnAgentForTask },
        sessionMetadata: {},
        brokerArgs: { mode: "spawn-sub-agent", task: "x" },
      }),
    );
    expect(res.success).toBe(false);
    expect(spawnAgentForTask).not.toHaveBeenCalled();
  });

  it("refuses (no spawn) without a task instruction", async () => {
    const spawnAgentForTask = vi.fn<SpawnFn>(async () => ({}));
    const res = await runParentAgentBroker(
      makeRequest({
        service: { spawnAgentForTask },
        sessionMetadata: { taskId: "t" },
        brokerArgs: { mode: "spawn-sub-agent" },
      }),
    );
    expect(res.success).toBe(false);
    expect(spawnAgentForTask).not.toHaveBeenCalled();
  });

  it("surfaces a spawn error (e.g. depth cap) as text, not a throw", async () => {
    const spawnAgentForTask = vi.fn<SpawnFn>(async () => {
      throw new Error("sub-agent nesting depth 4 exceeds the max of 3");
    });
    const res = await runParentAgentBroker(
      makeRequest({
        service: { spawnAgentForTask },
        sessionMetadata: { taskId: "t", nestingDepth: 3 },
        brokerArgs: { mode: "spawn-sub-agent", task: "x" },
      }),
    );
    expect(res.success).toBe(false);
    expect(res.text).toMatch(/exceeds the max/);
  });

  it("errors when the orchestrator service is unavailable", async () => {
    const res = await runParentAgentBroker(
      makeRequest({
        service: null,
        sessionMetadata: { taskId: "t" },
        brokerArgs: { mode: "spawn-sub-agent", task: "x" },
      }),
    );
    expect(res.success).toBe(false);
  });
});
