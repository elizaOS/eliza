import { describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

function makeService(store: OrchestratorTaskStore, acp?: unknown) {
  const runtime = {
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    reportError: vi.fn(),
    getService: (name: string) => {
      if (name === "ACPX_SUB_AGENT_ROUTER") return { releaseDeferredCompletionRelay: vi.fn() };
      if (name === "ACP" || name === "acp" || /acp/i.test(name)) return acp;
      return undefined;
    },
  };
  return new OrchestratorTaskService(runtime as never, { store });
}

async function addLane(store: OrchestratorTaskStore, taskId: string, sessionId: string, status: string, lastActivityAt: number) {
  const now = Date.now();
  await store.addSession({
    id: `row-${sessionId}`, taskId, sessionId, framework: "eliza-code", label: sessionId,
    originalTask: "x", workdir: "/tmp/w", status: status as never, decisionCount: 0, autoResolvedCount: 0,
    registeredAt: now, lastActivityAt, idleCheckCount: 0, taskDelivered: true, lastSeenDecisionIndex: 0,
    spawnedAt: now, retryCount: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheTokens: 0,
    costUsd: 0, usageState: "unavailable", metadata: {}, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
  } as never);
}

describe("repro: interruptTask on a paused task", () => {
  it("returns true, leaves status active, plants user stamp; room-wide interrupt includes it", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = makeService(store);
    const detail = await store.createTask({ title: "paused build", goal: "g", roomId: "room-1" } as never);
    const taskId = detail.task.id;
    await store.updateTask(taskId, { status: "active", paused: true, metadata: { pausedWithActiveWork: true } });

    const titles = await service.interruptInFlightTasksForRoom("room-1", "user_cancel");
    console.log("interruptInFlightTasksForRoom ->", titles);
    const after = await store.getTask(taskId);
    console.log("after interrupt: status=", after?.task.status, "paused=", after?.task.paused, "metadata=", JSON.stringify(after?.task.metadata));
    expect(titles).toEqual(["paused build"]);
    expect(after?.task.status).toBe("active");
    expect(after?.task.metadata?.interruptReason).toBe("user_cancel");

    // Direct interruptTask also returns true on a paused task.
    const d2 = await store.createTask({ title: "p2", goal: "g" } as never);
    await store.updateTask(d2.task.id, { status: "active", paused: true });
    const ok = await service.interruptTask(d2.task.id, "user_interrupt");
    const a2 = await store.getTask(d2.task.id);
    console.log("direct interruptTask ->", ok, "status=", a2?.task.status, "reason=", a2?.task.metadata?.interruptReason);
    expect(ok).toBe(true);
    expect(a2?.task.status).toBe("active");
  });

  it("resume after the cancel re-engages a fresh worker; a later reaper interrupt then reads as a user interrupt and attach refuses to self-heal", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const acpStub = { getSession: async () => undefined, serviceType: "acp" };
    const service = makeService(store, acpStub);
    const spawn = vi.spyOn(service as never as { spawnAgentForTask: () => Promise<unknown> }, "spawnAgentForTask" as never).mockResolvedValue(undefined as never);

    const detail = await store.createTask({ title: "paused build", goal: "g", roomId: "room-1" } as never);
    const taskId = detail.task.id;
    await store.updateTask(taskId, { status: "active", paused: true, metadata: { pausedWithActiveWork: true } });
    expect(await service.interruptTask(taskId, "user_cancel")).toBe(true);

    await service.resumeTask(taskId);
    const afterResume = await store.getTask(taskId);
    console.log("after resume: status=", afterResume?.task.status, "paused=", afterResume?.task.paused, "spawnCalls=", spawn.mock.calls.length, "metadata=", JSON.stringify(afterResume?.task.metadata));
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(afterResume?.task.status).toBe("active");
    expect(afterResume?.task.metadata?.interruptReason).toBe("user_cancel");

    // Now the reaper interrupts the (stale) active task: dead row + idle past threshold.
    const old = Date.now() - 60 * 60 * 1000;
    await addLane(store, taskId, "dead-1", "active", old);
    await store.updateTask(taskId, { lastActivityAt: old } as never);
    const reaped = await service.reapStuckTasks(Date.now());
    console.log("reaped ->", reaped);
    const afterReap = await store.getTask(taskId);
    console.log("after reap: status=", afterReap?.task.status, "reason=", afterReap?.task.metadata?.interruptReason);
    expect(reaped).toEqual([taskId]);
    expect(afterReap?.task.status).toBe("interrupted");

    // Attach of a fresh worker: a reaper interrupt should self-heal to active, but the stale user stamp blocks it.
    await service.attachSession(taskId, { sessionId: "retry-1", agentType: "eliza-code", workdir: "/tmp/w", status: "ready" } as never);
    const afterAttach = await store.getTask(taskId);
    console.log("after attach: status=", afterAttach?.task.status);
    expect(afterAttach?.task.status).toBe("interrupted");
  });
});
