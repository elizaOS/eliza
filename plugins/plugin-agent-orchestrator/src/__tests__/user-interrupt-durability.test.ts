/**
 * A user stop sticks: a late attach must not resurrect the task, a stopped
 * child's trailing completion is neither verified nor relayed, and a parked
 * lane never strands its sibling's pass in `validating`. Real service +
 * memory store, no model.
 */
import { describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";

function makeService(
  store: OrchestratorTaskStore,
  released: string[] = [],
): OrchestratorTaskService {
  const runtime = {
    character: { name: "Tester" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getSetting: () => undefined,
    reportError: vi.fn(),
    getService: (name: string) =>
      name === "ACPX_SUB_AGENT_ROUTER"
        ? {
            releaseDeferredCompletionRelay: (
              _t: string,
              v: string,
              s?: string,
            ) => released.push(`${v}:${s}`),
          }
        : undefined,
  };
  return new OrchestratorTaskService(runtime as never, { store });
}

async function addLane(
  store: OrchestratorTaskStore,
  taskId: string,
  sessionId: string,
  part: string,
): Promise<void> {
  const now = Date.now();
  await store.addSession({
    id: `row-${sessionId}`,
    taskId,
    sessionId,
    framework: "eliza-code",
    label: sessionId,
    originalTask: `--- User Task ---\nBuild ${sessionId}\n\n--- Script tasks ---\nx`,
    workdir: "/tmp/w",
    status: "completed",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: true,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: { requestVoicePart: part },
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
}

describe("user interrupt durability", () => {
  it("a late attach does not resurrect a user-interrupted task; a restart does", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = makeService(store);
    const detail = await store.createTask({ title: "t", goal: "g" });
    const taskId = detail.task.id;
    await store.updateTask(taskId, { status: "active" });
    expect(await service.interruptTask(taskId, "user_interrupt")).toBe(true);
    expect((await store.getTask(taskId))?.task.metadata?.interruptReason).toBe(
      "user_interrupt",
    );

    await service.attachSession(taskId, {
      sessionId: "late",
      agentType: "eliza-code",
      workdir: "/tmp/w",
      status: "ready",
    });
    expect((await store.getTask(taskId))?.task.status).toBe("interrupted");

    // The reaper's interrupt still self-heals on attach.
    const reaped = await store.createTask({ title: "r", goal: "g" });
    await store.updateTask(reaped.task.id, { status: "active" });
    await service.interruptTask(reaped.task.id, "stuck_task_reaper");
    await service.attachSession(reaped.task.id, {
      sessionId: "retry",
      agentType: "eliza-code",
      workdir: "/tmp/w",
      status: "ready",
    });
    expect((await store.getTask(reaped.task.id))?.task.status).toBe("active");
  });

  it("a completion after the user stopped the task is not verified", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = makeService(store);
    const detail = await store.createTask({
      title: "t",
      goal: "g",
      acceptanceCriteria: ["x"],
    });
    const taskId = detail.task.id;
    await addLane(store, taskId, "only", "part:0");
    await store.updateTask(taskId, { status: "active" });
    await service.interruptTask(taskId, "user_interrupt");
    await (
      service as unknown as {
        applySessionEvent: (
          taskId: string,
          sessionId: string,
          event: string,
          data: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).applySessionEvent(taskId, "only", "task_complete", {
      response: "done, it's live",
    });
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("interrupted");
    expect(
      doc?.events.some((e) => e.eventType === "completion_after_interrupt"),
    ).toBe(true);
  });

  it("a parked lane does not strand the sibling's pass in validating", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const released: string[] = [];
    const service = makeService(store, released);
    const detail = await store.createTask({
      title: "two pages",
      goal: "two pages",
      acceptanceCriteria: ["reachable"],
    });
    const taskId = detail.task.id;
    await addLane(store, taskId, "coin", "part:0");
    await addLane(store, taskId, "dice", "part:1");
    await store.updateTask(taskId, { status: "validating" });
    const reEngage = (
      service as unknown as {
        reEngageOrEscalate: (args: Record<string, unknown>) => Promise<void>;
      }
    ).reEngageOrEscalate.bind(service);
    // dice fails at the cap → parked, with a lane verdict.
    await reEngage({
      taskId,
      sessionId: "dice",
      correction: "fix",
      eventType: "auto_verify_failed",
      verifier: "judge",
      summary: "dice 404",
      missing: ["url"],
      attempt: 3,
    });
    let doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("waiting_on_user");
    expect(doc?.task.metadata?.laneVerdicts).toEqual({ dice: "parked" });
    expect(released).toEqual(["failed:dice"]);

    // coin's completion lifts the task to validating, then passes: the park
    // is restored instead of the task sitting validating forever.
    await store.updateTask(taskId, { status: "validating" });
    await service.validateTask(
      taskId,
      { passed: true, summary: "coin ok" },
      "coin",
    );
    doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("waiting_on_user");
    expect(doc?.task.metadata?.laneVerdicts).toEqual({
      dice: "parked",
      coin: "passed",
    });
    expect(released).toEqual(["failed:dice", "passed:coin"]);
  });

  it("verify attempts are budgeted per lane", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = makeService(store);
    const detail = await store.createTask({
      title: "two pages",
      goal: "two pages",
      acceptanceCriteria: ["reachable"],
    });
    const taskId = detail.task.id;
    await addLane(store, taskId, "coin", "part:0");
    await addLane(store, taskId, "dice", "part:1");
    await store.updateTask(taskId, {
      status: "validating",
      metadata: { laneAutoVerifyAttempts: { coin: 3 }, autoVerifyAttempts: 3 },
    });
    const doc = await store.getTask(taskId);
    const attemptsFor = (
      service as unknown as {
        laneAutoVerifyAttempts: (d: unknown, s: string) => number;
      }
    ).laneAutoVerifyAttempts.bind(service);
    expect(attemptsFor(doc, "coin")).toBe(3);
    expect(attemptsFor(doc, "dice")).toBe(0);
  });

  it("a session error on a user-interrupted task does not resurrect it", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = makeService(store);
    const detail = await store.createTask({ title: "t", goal: "g" });
    const taskId = detail.task.id;
    await addLane(store, taskId, "w1", "part:0");
    await store.updateTask(taskId, { status: "active" });
    await service.interruptTask(taskId, "user_interrupt");
    await (
      service as unknown as {
        applySessionEvent: (
          t: string,
          s: string,
          e: string,
          d: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).applySessionEvent(taskId, "w1", "error", {
      failureKind: "session_state_lost",
      message: "state lost",
    });
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("interrupted");
    expect(doc?.task.metadata?.interruptReason).toBe("user_interrupt");
  });

  it("a user stop on a paused task still interrupts it", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const service = makeService(store);
    const detail = await store.createTask({ title: "t", goal: "g" });
    const taskId = detail.task.id;
    await store.updateTask(taskId, { status: "active", paused: true });
    expect(await service.interruptTask(taskId, "user_interrupt")).toBe(true);
    const doc = await store.getTask(taskId);
    expect(doc?.task.status).toBe("interrupted");
    expect(doc?.task.paused).toBeFalsy();
  });

  it("each parked lane gets its own notice; a lane verified under a sibling's park still lands", async () => {
    const store = new OrchestratorTaskStore({ backend: "memory" });
    const released: string[] = [];
    const notices: string[] = [];
    const service = makeService(store, released);
    (
      service as unknown as { runtime: Record<string, unknown> }
    ).runtime.sendMessageToTarget = async (
      _t: unknown,
      content: { text: string },
    ) => {
      notices.push(content.text);
    };
    (service as unknown as { runtime: { getRoom?: unknown } }).runtime.getRoom =
      async () => ({ source: "discord" });
    const detail = await store.createTask({
      title: "two pages",
      goal: "two pages",
      acceptanceCriteria: ["reachable"],
    });
    const taskId = detail.task.id;
    await addLane(store, taskId, "coin", "part:0");
    await addLane(store, taskId, "dice", "part:1");
    await store.updateTask(taskId, {
      status: "validating",
      roomId: "room-1",
      metadata: { source: "discord" },
    });
    const reEngage = (
      service as unknown as {
        reEngageOrEscalate: (args: Record<string, unknown>) => Promise<void>;
      }
    ).reEngageOrEscalate.bind(service);
    await reEngage({
      taskId,
      sessionId: "dice",
      correction: "fix",
      eventType: "auto_verify_failed",
      verifier: "judge",
      summary: "dice 404",
      missing: ["url"],
      attempt: 3,
    });
    expect((await store.getTask(taskId))?.task.status).toBe("waiting_on_user");
    // coin's pass lands even while the task is parked by dice…
    await service.validateTask(
      taskId,
      { passed: true, summary: "coin ok" },
      "coin",
    );
    let doc = await store.getTask(taskId);
    expect(doc?.task.metadata?.laneVerdicts).toEqual({
      dice: "parked",
      coin: "passed",
    });
    expect(doc?.task.status).toBe("waiting_on_user");
    // …and a second lane's park is NOT silenced by the first's notice.
    await store.updateTask(taskId, {
      metadata: { ...(doc?.task.metadata ?? {}), laneVerdicts: {} },
      status: "validating",
    });
    await reEngage({
      taskId,
      sessionId: "coin",
      correction: "fix",
      eventType: "auto_verify_failed",
      verifier: "judge",
      summary: "coin 404",
      missing: ["url"],
      attempt: 3,
    });
    expect(notices.length).toBe(2);
  });
});
