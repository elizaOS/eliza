/**
 * Exercises the durable aggregate-completion barrier through the real task
 * service and in-memory store. ACP transport is deterministic: it records
 * coordinator-review prompts and can inject delivery failures, while every
 * task/session transition remains production code.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AcpService } from "../services/acp-service.js";
import { OrchestratorTaskService } from "../services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../services/orchestrator-task-store.js";
import type {
  OrchestratorTaskSession,
  TaskCompletionRole,
} from "../services/orchestrator-task-types.js";

type EventHandler = (
  sessionId: string,
  event: string,
  data: unknown,
  sessionSnapshot?: Record<string, unknown>,
) => void | Promise<void>;

class BarrierAcp {
  private handler: EventHandler | undefined;
  readonly sent: Array<{ sessionId: string; text: string }> = [];
  deliveryError: Error | undefined;
  emitCoordinatorCompletionOnSend = false;

  onSessionEvent(handler: EventHandler): () => void {
    this.handler = handler;
    return () => {
      this.handler = undefined;
    };
  }

  async sendToSession(sessionId: string, text: string): Promise<object> {
    if (this.deliveryError) throw this.deliveryError;
    this.sent.push({ sessionId, text });
    if (this.emitCoordinatorCompletionOnSend) {
      void this.handler?.(sessionId, "task_complete", {
        response: "reviewed receipts and verified aggregate work",
      });
    }
    return { stopReason: "end_turn", finalText: "reviewed" };
  }

  getOrchestratorOwnedArtifacts(): [] {
    return [];
  }

  async emit(sessionId: string, event: string, data: unknown): Promise<void> {
    await this.handler?.(sessionId, event, data);
  }

  async emitSuccessor(
    sessionId: string,
    event: string,
    data: unknown,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.handler?.(sessionId, event, data, {
      id: sessionId,
      agentType: "elizaos",
      workdir: process.cwd(),
      status: "ready",
      metadata,
    });
  }
}

const previousAutoVerify = process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
const previousResiduals = process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE;

beforeAll(() => {
  process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = "0";
  process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE = "0";
});

afterAll(() => {
  if (previousAutoVerify === undefined) {
    delete process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY;
  } else {
    process.env.ELIZA_ORCHESTRATOR_AUTO_GOAL_VERIFY = previousAutoVerify;
  }
  if (previousResiduals === undefined) {
    delete process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE;
  } else {
    process.env.ELIZA_ORCHESTRATOR_RESIDUALS_GATE = previousResiduals;
  }
});

function runtime(acp: BarrierAcp) {
  return {
    character: { name: "Coordinator" },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    reportError: vi.fn(),
    getSetting: () => undefined,
    getService: (type: string) =>
      type === AcpService.serviceType ? acp : undefined,
    useModel: vi.fn(async () => "{}"),
  };
}

function session(input: {
  taskId: string;
  sessionId: string;
  role?: TaskCompletionRole;
  parentSessionId?: string;
  required?: boolean;
}): OrchestratorTaskSession {
  const now = Date.now();
  return {
    id: `row-${input.sessionId}`,
    taskId: input.taskId,
    sessionId: input.sessionId,
    framework: "elizaos",
    label: input.sessionId,
    originalTask: "finish the aggregate goal",
    workdir: process.cwd(),
    status: "ready",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: now,
    lastActivityAt: now,
    idleCheckCount: 0,
    taskDelivered: false,
    lastSeenDecisionIndex: 0,
    spawnedAt: now,
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    ...(input.role ? { completionRole: input.role } : {}),
    ...(input.parentSessionId
      ? { parentSessionId: input.parentSessionId }
      : {}),
    ...(input.required === undefined
      ? {}
      : { requiredForTaskCompletion: input.required }),
    metadata: {},
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  };
}

async function harness(options: { legacySingle?: boolean } = {}) {
  const acp = new BarrierAcp();
  const store = new OrchestratorTaskStore({ backend: "memory" });
  const created = await store.createTask({
    title: "aggregate completion",
    goal: "finish the aggregate goal",
    acceptanceCriteria: [],
  });
  const taskId = created.task.id;
  await store.addSession(
    session({
      taskId,
      sessionId: "coordinator",
      ...(options.legacySingle ? {} : { role: "coordinator", required: false }),
    }),
  );
  if (!options.legacySingle) {
    await store.addSession(
      session({
        taskId,
        sessionId: "contributor",
        role: "contributor",
        parentSessionId: "coordinator",
        required: true,
      }),
    );
    await store.updateTask(taskId, {
      completionCoordinatorSessionId: "coordinator",
    });
  }
  await store.updateTask(taskId, { status: "active" });
  const service = new OrchestratorTaskService(runtime(acp) as never, { store });
  await service.start();
  return { acp, store, service, taskId };
}

describe("aggregate completion barrier", () => {
  it("keeps contributor-first evidence provisional", async () => {
    const h = await harness();
    await h.acp.emit("contributor", "task_complete", {
      response: "contributor result in full",
    });
    const doc = await h.store.getTask(h.taskId);
    expect(doc?.task.status).toBe("active");
    expect(h.acp.sent).toEqual([]);
    await h.service.stop();
  });

  it("waits when the coordinator completes while a required child is busy", async () => {
    const h = await harness();
    await h.acp.emit("coordinator", "task_complete", {
      response: "my part is done",
    });
    const doc = await h.store.getTask(h.taskId);
    expect(doc?.task.status).toBe("active");
    expect(
      doc?.sessions.find((row) => row.sessionId === "coordinator")
        ?.aggregateCompletionRequestedAt,
    ).toBeTruthy();
    expect(h.acp.sent).toEqual([]);
    await h.service.stop();
  });

  it("delivers the final contributor receipt and requires a second coordinator completion", async () => {
    const h = await harness();
    await h.acp.emit("coordinator", "task_complete", {
      response: "my part is done",
    });
    await h.acp.emit("contributor", "task_complete", {
      response: "full child result",
    });
    await vi.waitFor(() => expect(h.acp.sent).toHaveLength(1));
    expect(h.acp.sent[0]).toMatchObject({ sessionId: "coordinator" });
    expect(h.acp.sent[0]?.text).toContain("full child result");
    expect((await h.store.getTask(h.taskId))?.task.status).toBe("active");

    await h.acp.emit("coordinator", "task_complete", {
      response: "reviewed and aggregate verified",
    });
    await vi.waitFor(async () => {
      expect((await h.store.getTask(h.taskId))?.task.status).toBe("validating");
    });
    const final = await h.store.getTask(h.taskId);
    expect(
      final?.sessions.find((row) => row.sessionId === "contributor")
        ?.contributionReviewedAt,
    ).toBeTruthy();
    await h.service.stop();
  });

  it("serializes simultaneous sibling completions and sends one review", async () => {
    const h = await harness();
    await Promise.all([
      h.acp.emit("coordinator", "task_complete", { response: "coord" }),
      h.acp.emit("contributor", "task_complete", { response: "child" }),
    ]);
    await vi.waitFor(() => expect(h.acp.sent).toHaveLength(1));
    expect((await h.store.getTask(h.taskId))?.task.status).toBe("active");
    await h.service.stop();
  });

  it("authorizes the production-like completion emitted by the review turn", async () => {
    const h = await harness();
    h.acp.emitCoordinatorCompletionOnSend = true;
    await h.acp.emit("coordinator", "task_complete", { response: "coord" });
    await h.acp.emit("contributor", "task_complete", { response: "child" });
    await vi.waitFor(async () => {
      expect((await h.store.getTask(h.taskId))?.task.status).toBe("validating");
    });
    expect(h.acp.sent).toHaveLength(1);
    await h.service.stop();
  });

  it("does not settle through a blocked required child", async () => {
    const h = await harness();
    await h.acp.emit("contributor", "blocked", { message: "need API key" });
    await h.acp.emit("coordinator", "task_complete", { response: "coord" });
    expect((await h.store.getTask(h.taskId))?.task.status).toBe("blocked");
    expect(h.acp.sent).toEqual([]);
    await h.service.stop();
  });

  it("persists receipt delivery failure without authorizing completion", async () => {
    const h = await harness();
    h.acp.deliveryError = new Error("coordinator transport unavailable");
    await h.acp.emit("coordinator", "task_complete", { response: "coord" });
    await h.acp.emit("contributor", "task_complete", { response: "child" });
    await vi.waitFor(async () => {
      const contributor = (await h.store.getTask(h.taskId))?.sessions.find(
        (row) => row.sessionId === "contributor",
      );
      expect(contributor?.completionReceiptDeliveryError).toContain(
        "transport unavailable",
      );
    });
    const doc = await h.store.getTask(h.taskId);
    expect(doc?.task.status).toBe("waiting_on_user");
    expect(
      doc?.sessions.find((row) => row.sessionId === "contributor")
        ?.completionReceiptDeliveredAt,
    ).toBeUndefined();
    expect(
      doc?.events.some(
        (event) => event.eventType === "completion_review_delivery_failed",
      ),
    ).toBe(true);

    h.acp.deliveryError = undefined;
    await h.service.recoverCompletionBarriers();
    await vi.waitFor(() => expect(h.acp.sent).toHaveLength(1));
    expect(
      (await h.store.getTask(h.taskId))?.sessions.find(
        (row) => row.sessionId === "contributor",
      )?.completionReceiptDeliveredAt,
    ).toBeTruthy();
    await h.service.stop();
  });

  it("recovers a pending receipt delivery after service restart", async () => {
    const h = await harness();
    h.acp.deliveryError = new Error("offline");
    await h.acp.emit("coordinator", "task_complete", { response: "coord" });
    await h.acp.emit("contributor", "task_complete", { response: "child" });
    await vi.waitFor(async () => {
      const contributor = (await h.store.getTask(h.taskId))?.sessions.find(
        (row) => row.sessionId === "contributor",
      );
      expect(contributor?.completionReceiptDeliveryError).toBe("offline");
    });
    await h.service.stop();

    const recoveredAcp = new BarrierAcp();
    const recovered = new OrchestratorTaskService(
      runtime(recoveredAcp) as never,
      { store: h.store },
    );
    await recovered.start();
    await recovered.recoverCompletionBarriers();
    await vi.waitFor(() => expect(recoveredAcp.sent).toHaveLength(1));
    const doc = await h.store.getTask(h.taskId);
    expect(
      doc?.sessions.find((row) => row.sessionId === "contributor")
        ?.completionReceiptDeliveredAt,
    ).toBeTruthy();
    await recovered.stop();
  });

  it("transfers authority explicitly and preserves one elected coordinator", async () => {
    const h = await harness();
    await h.store.updateSession(
      "coordinator",
      { status: "errored", stoppedAt: Date.now() },
      h.taskId,
    );
    await h.service.transferCompletionCoordinator(h.taskId, "contributor");
    const doc = await h.store.getTask(h.taskId);
    expect(doc?.task.completionCoordinatorSessionId).toBe("contributor");
    expect(
      doc?.sessions.find((row) => row.sessionId === "coordinator"),
    ).toMatchObject({
      completionRole: "contributor",
      requiredForTaskCompletion: false,
    });
    expect(
      doc?.sessions.find((row) => row.sessionId === "contributor"),
    ).toMatchObject({
      completionRole: "coordinator",
      requiredForTaskCompletion: false,
    });
    await h.service.stop();
  });

  it("lets a completing legacy retry elect itself without requiring old attempts", async () => {
    const h = await harness({ legacySingle: true });
    await h.store.updateSession(
      "coordinator",
      { status: "errored", stoppedAt: Date.now() },
      h.taskId,
    );
    await h.store.addSession(
      session({ taskId: h.taskId, sessionId: "legacy-retry" }),
    );
    await h.store.updateTask(h.taskId, { status: "active" });
    await h.acp.emit("legacy-retry", "task_complete", { response: "fixed" });
    await vi.waitFor(async () => {
      expect((await h.store.getTask(h.taskId))?.task.status).toBe("validating");
    });
    expect(
      (await h.store.getTask(h.taskId))?.task.completionCoordinatorSessionId,
    ).toBe("legacy-retry");
    await h.service.stop();
  });

  it("transfers coordinator authority to an automatic state-lost successor", async () => {
    const h = await harness();
    await h.store.updateSession(
      "coordinator",
      { status: "errored", stoppedAt: Date.now() },
      h.taskId,
    );
    await h.store.updateSession(
      "contributor",
      { requiredForTaskCompletion: false },
      h.taskId,
    );
    const metadata = {
      taskId: h.taskId,
      retryOfSessionId: "coordinator",
      completionRole: "coordinator",
      requiredForTaskCompletion: false,
      initialTask: "resume coordinator work",
    };
    await h.acp.emitSuccessor("coordinator-retry", "ready", {}, metadata);
    await h.acp.emitSuccessor(
      "coordinator-retry",
      "task_complete",
      { response: "recovered and done" },
      metadata,
    );
    await vi.waitFor(async () => {
      expect((await h.store.getTask(h.taskId))?.task.status).toBe("validating");
    });
    const doc = await h.store.getTask(h.taskId);
    expect(doc?.task.completionCoordinatorSessionId).toBe("coordinator-retry");
    expect(
      doc?.sessions.find((row) => row.sessionId === "coordinator")
        ?.requiredForTaskCompletion,
    ).toBe(false);
    await h.service.stop();
  });

  it("transfers a required contribution to an automatic failover successor", async () => {
    const h = await harness();
    await h.acp.emit("coordinator", "task_complete", { response: "coord" });
    await h.store.updateSession(
      "contributor",
      { status: "errored", stoppedAt: Date.now() },
      h.taskId,
    );
    const metadata = {
      taskId: h.taskId,
      retryOfSessionId: "contributor",
      completionRole: "contributor",
      requiredForTaskCompletion: true,
      parentSessionId: "coordinator",
      initialTask: "resume contributor work",
    };
    await h.acp.emitSuccessor("contributor-retry", "ready", {}, metadata);
    await h.acp.emitSuccessor(
      "contributor-retry",
      "task_complete",
      { response: "recovered contribution" },
      metadata,
    );
    await vi.waitFor(() => expect(h.acp.sent).toHaveLength(1));
    const doc = await h.store.getTask(h.taskId);
    expect(
      doc?.sessions.find((row) => row.sessionId === "contributor")
        ?.requiredForTaskCompletion,
    ).toBe(false);
    expect(
      doc?.sessions.find((row) => row.sessionId === "contributor-retry"),
    ).toMatchObject({
      completionRole: "contributor",
      requiredForTaskCompletion: true,
      parentSessionId: "coordinator",
    });
    expect(h.acp.sent[0]?.text).toContain("recovered contribution");
    await h.service.stop();
  });

  it("keeps persisted single-session tasks backward compatible", async () => {
    const h = await harness({ legacySingle: true });
    await h.acp.emit("coordinator", "task_complete", { response: "done" });
    await vi.waitFor(async () => {
      expect((await h.store.getTask(h.taskId))?.task.status).toBe("validating");
    });
    expect(
      (await h.store.getTask(h.taskId))?.task.completionCoordinatorSessionId,
    ).toBe("coordinator");
    await h.service.stop();
  });
});
