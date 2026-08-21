/**
 * Contract tests for the cross-domain workflow execution engine in
 * WorkflowsDomain: step lineage recording, reverse-order failure
 * compensation, per-workflow run serialization, and idempotent replay.
 * Deterministic vitest harness — the workflow-step registry holds
 * protocol-faithful in-memory step contributions standing in for the
 * calendar/inbox/reminders domains; the system under test (the engine) is
 * real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  LifeOpsAuditEvent,
  LifeOpsWorkflowDefinition,
  LifeOpsWorkflowRun,
} from "../../contracts/index.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import {
  type AnyWorkflowStepContribution,
  createWorkflowStepRegistry,
  registerWorkflowStepRegistry,
  type WorkflowStepExecuteContext,
  type WorkflowStepRegistry,
} from "../registries/workflow-step-registry.js";
import { LifeOpsWorkflowRunFailedUncompensatedError } from "../service-types.js";
import { type WorkflowsDeps, WorkflowsDomain } from "./workflows-service.js";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa";
const SECOND_AGENT_ID = "00000000-0000-0000-0000-0000000000bb";
const NOW = "2026-08-20T09:00:00.000Z";
const LATER = "2026-08-20T09:01:00.000Z";

function makeDefinition(
  steps: Array<Record<string, unknown>>,
  options: { agentId?: string; workflowId?: string } = {},
): LifeOpsWorkflowDefinition {
  const agentId = options.agentId ?? AGENT_ID;
  return {
    id: options.workflowId ?? "wf-1",
    agentId,
    domain: "personal",
    subjectType: "owner",
    subjectId: `owner-${agentId}`,
    visibilityScope: "owner_private",
    contextPolicy: "always",
    title: "cross-domain test workflow",
    triggerType: "manual",
    schedule: { kind: "manual" },
    actionPlan: {
      steps:
        steps as unknown as LifeOpsWorkflowDefinition["actionPlan"]["steps"],
    },
    permissionPolicy: {
      allowBrowserActions: false,
      trustedBrowserActions: false,
      allowXPosts: false,
      trustedXPosting: false,
      requireConfirmationForBrowserActions: true,
      requireConfirmationForXPosts: true,
    },
    status: "active",
    createdBy: "user",
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  } as LifeOpsWorkflowDefinition;
}

type Harness = {
  domain: WorkflowsDomain;
  registry: WorkflowStepRegistry;
  runs: LifeOpsWorkflowRun[];
  repository: {
    claimWorkflowRun: ReturnType<typeof vi.fn>;
    completeWorkflowRun: ReturnType<typeof vi.fn>;
    createWorkflowRun: ReturnType<typeof vi.fn>;
    getWorkflowRunByIdempotencyKey: ReturnType<typeof vi.fn>;
    listWorkflows: ReturnType<typeof vi.fn>;
    listWorkflowRuns: ReturnType<typeof vi.fn>;
    updateWorkflow: ReturnType<typeof vi.fn>;
  };
  emitWorkflowRunNudge: ReturnType<typeof vi.fn>;
  logLifeOpsWarn: ReturnType<typeof vi.fn>;
  reportError: ReturnType<typeof vi.fn>;
  getWorkflowDefinition: ReturnType<typeof vi.fn>;
  setAgentId(agentId: string): void;
};

function makeHarness(): Harness {
  let currentAgentId = AGENT_ID;
  const reportError = vi.fn();
  const runtime = { agentId: currentAgentId, reportError };
  const registry = createWorkflowStepRegistry();
  registerWorkflowStepRegistry(
    runtime as unknown as Parameters<typeof registerWorkflowStepRegistry>[0],
    registry,
  );
  const runs: LifeOpsWorkflowRun[] = [];

  const cloneRun = (run: LifeOpsWorkflowRun): LifeOpsWorkflowRun =>
    structuredClone(run);
  const claimWorkflowRun = vi.fn(async (run: LifeOpsWorkflowRun) => {
    if (run.status !== "running" || run.finishedAt !== null) {
      throw new Error("workflow claims must start in running state");
    }
    const conflicts = runs.some(
      (current) =>
        current.id === run.id ||
        (run.idempotencyKey !== null &&
          current.agentId === run.agentId &&
          current.workflowId === run.workflowId &&
          current.idempotencyKey === run.idempotencyKey),
    );
    if (conflicts) return false;
    runs.push(cloneRun(run));
    return true;
  });
  const getWorkflowRunByIdempotencyKey = vi.fn(
    async (agentId: string, workflowId: string, idempotencyKey: string) => {
      const run = runs.find(
        (current) =>
          current.agentId === agentId &&
          current.workflowId === workflowId &&
          current.idempotencyKey === idempotencyKey,
      );
      return run ? cloneRun(run) : null;
    },
  );
  const completeWorkflowRun = vi.fn(async (run: LifeOpsWorkflowRun) => {
    if (
      run.finishedAt === null ||
      run.status === "queued" ||
      run.status === "running"
    ) {
      throw new Error("workflow completions must be terminal");
    }
    const index = runs.findIndex(
      (current) =>
        current.id === run.id &&
        current.agentId === run.agentId &&
        current.workflowId === run.workflowId &&
        current.idempotencyKey === run.idempotencyKey &&
        current.status === "running" &&
        current.finishedAt === null,
    );
    if (index < 0) return false;
    runs[index] = cloneRun(run);
    return true;
  });
  const createWorkflowRun = vi.fn(async (run: LifeOpsWorkflowRun) => {
    if (runs.some((current) => current.id === run.id)) {
      throw new Error("duplicate workflow run id");
    }
    runs.push(cloneRun(run));
  });
  const listWorkflowRuns = vi.fn(async (agentId: string, workflowId: string) =>
    runs
      .filter((run) => run.agentId === agentId && run.workflowId === workflowId)
      .map(cloneRun),
  );
  const listWorkflows = vi.fn(async () => [] as LifeOpsWorkflowDefinition[]);
  const updateWorkflow = vi.fn(async () => undefined);
  const repository = {
    claimWorkflowRun,
    completeWorkflowRun,
    createWorkflowRun,
    getWorkflowRunByIdempotencyKey,
    listWorkflows,
    listWorkflowRuns,
    updateWorkflow,
  };
  const logLifeOpsWarn = vi.fn();
  const ctx = {
    runtime,
    repository,
    agentId: () => currentAgentId,
    logLifeOpsWarn,
  };
  const emitWorkflowRunNudge = vi.fn(async () => undefined);
  const deps = {
    recordWorkflowAudit: vi.fn(
      async (): Promise<LifeOpsAuditEvent> =>
        ({ id: `audit-${runs.length}` }) as LifeOpsAuditEvent,
    ),
    getWorkflowDefinition: vi.fn(),
    readEffectiveScheduleState: vi.fn(async () => null),
    emitWorkflowRunNudge,
    workflowStepContext: {} as WorkflowStepExecuteContext,
  };
  const domain = new WorkflowsDomain(
    ctx as unknown as LifeOpsContext,
    deps as unknown as WorkflowsDeps,
  );
  return {
    domain,
    registry,
    runs,
    repository,
    emitWorkflowRunNudge,
    logLifeOpsWarn,
    reportError,
    getWorkflowDefinition: deps.getWorkflowDefinition,
    setAgentId(agentId: string) {
      currentAgentId = agentId;
      runtime.agentId = agentId;
    },
  };
}

function storedRun(args: {
  id: string;
  idempotencyKey: string;
  status: LifeOpsWorkflowRun["status"];
  agentId?: string;
  workflowId?: string;
  result?: Record<string, unknown>;
}): LifeOpsWorkflowRun {
  const terminal = args.status !== "queued" && args.status !== "running";
  return {
    id: args.id,
    agentId: args.agentId ?? AGENT_ID,
    workflowId: args.workflowId ?? "wf-1",
    idempotencyKey: args.idempotencyKey,
    startedAt: NOW,
    finishedAt: terminal ? LATER : null,
    status: args.status,
    result: {
      idempotencyKey: args.idempotencyKey,
      ...(args.result ?? {}),
    },
    auditRef: terminal ? `audit-${args.id}` : null,
  };
}

function contribution(
  kind: string,
  provider: string,
  execute: AnyWorkflowStepContribution["execute"],
  compensate?: AnyWorkflowStepContribution["compensate"],
): AnyWorkflowStepContribution {
  return {
    kind,
    describe: { label: kind, description: kind, provider },
    paramSchema: z
      .object({ kind: z.literal(kind), resultKey: z.string().optional() })
      .passthrough() as unknown as AnyWorkflowStepContribution["paramSchema"],
    execute,
    ...(compensate ? { compensate } : {}),
  };
}

describe("WorkflowsDomain execution contract", () => {
  let harness: Harness;

  beforeEach(() => {
    harness = makeHarness();
  });

  it("records provider and input-key lineage across composed domain steps", async () => {
    harness.registry.register(
      contribution("fetch_calendar", "calendar", async () => ({ events: 2 })),
    );
    harness.registry.register(
      contribution("fetch_inbox", "inbox", async () => ({ unread: 3 })),
    );
    harness.registry.register(
      contribution("plan_reminder", "reminders", async (_step, args) => ({
        planFrom: Object.keys(args.outputs).sort(),
      })),
    );
    const definition = makeDefinition([
      { kind: "fetch_calendar", resultKey: "calendar" },
      { kind: "fetch_inbox", resultKey: "inbox" },
      { kind: "plan_reminder", resultKey: "plan" },
    ]);

    const result = await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
    });

    expect(result.error).toBeNull();
    expect(result.run.status).toBe("success");
    const steps = result.run.result.steps as Array<Record<string, unknown>>;
    expect(steps.map((s) => s.provider)).toEqual([
      "calendar",
      "inbox",
      "reminders",
    ]);
    expect(steps[0]?.inputKeys).toEqual([]);
    expect(steps[1]?.inputKeys).toEqual(["calendar"]);
    expect(steps[2]?.inputKeys).toEqual(["calendar", "inbox"]);
    expect(steps[2]?.value).toEqual({ planFrom: ["calendar", "inbox"] });
  });

  it("compensates executed steps in reverse order when a later step fails", async () => {
    const order: string[] = [];
    const workflowFailure = new Error("upstream unavailable");
    harness.registry.register(
      contribution(
        "create_reminder",
        "reminders",
        async () => ({ reminderId: "r-1" }),
        async (_step, args) => {
          order.push(
            `undo_reminder:${(args.executedValue as { reminderId: string }).reminderId}`,
          );
        },
      ),
    );
    harness.registry.register(
      contribution(
        "create_event",
        "calendar",
        async () => ({ eventId: "e-1" }),
        async () => {
          order.push("undo_event");
        },
      ),
    );
    harness.registry.register(
      contribution("notify", "inbox", async () => {
        throw workflowFailure;
      }),
    );
    const definition = makeDefinition([
      { kind: "create_reminder", resultKey: "reminder" },
      { kind: "create_event", resultKey: "event" },
      { kind: "notify" },
    ]);

    const result = await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
    });

    expect(result.run.status).toBe("failed");
    expect(result.error).toBe(workflowFailure);
    expect(result.disposition).toBe("executed");
    expect(order).toEqual(["undo_event", "undo_reminder:r-1"]);
    expect(result.run.result.compensations).toEqual([
      { kind: "create_event", status: "compensated" },
      { kind: "create_reminder", status: "compensated" },
    ]);
    expect(harness.reportError).not.toHaveBeenCalled();
    expect(harness.runs).toEqual([
      expect.objectContaining({ id: result.run.id, status: "failed" }),
    ]);
  });

  it("marks a partial compensation failure, reports it, and continues reverse unwind", async () => {
    const order: string[] = [];
    const compensationFailure = new Error("undo failed");
    const workflowFailure = new Error("boom");
    harness.registry.register(
      contribution(
        "step_a",
        "calendar",
        async () => "a",
        async () => {
          order.push("undo_a");
        },
      ),
    );
    harness.registry.register(
      contribution(
        "step_b",
        "inbox",
        async () => "b",
        async () => {
          order.push("undo_b");
          throw compensationFailure;
        },
      ),
    );
    harness.registry.register(
      contribution("step_c", "finance", async () => {
        throw workflowFailure;
      }),
    );
    const definition = makeDefinition([
      { kind: "step_a" },
      { kind: "step_b" },
      { kind: "step_c" },
    ]);

    const result = await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
    });

    expect(order).toEqual(["undo_b", "undo_a"]);
    expect(result.disposition).toBe("executed");
    expect(result.run.status).toBe("failed_uncompensated");
    expect(result.run.result.compensations).toEqual([
      { kind: "step_b", status: "compensation_failed", error: "undo failed" },
      { kind: "step_a", status: "compensated" },
    ]);
    expect(result.error).toBeInstanceOf(
      LifeOpsWorkflowRunFailedUncompensatedError,
    );
    expect(result.error).toMatchObject({
      status: 500,
      code: "WORKFLOW_RUN_FAILED_UNCOMPENSATED",
      cause: workflowFailure,
      failedCompensationKinds: ["step_b"],
      run: expect.objectContaining({
        id: result.run.id,
        status: "failed_uncompensated",
      }),
    });
    expect(harness.reportError).toHaveBeenCalledWith(
      "workflow_step_compensation",
      compensationFailure,
      expect.objectContaining({
        workflowId: "wf-1",
        stepKind: "step_b",
      }),
    );
    expect(harness.runs).toEqual([
      expect.objectContaining({
        id: result.run.id,
        status: "failed_uncompensated",
      }),
    ]);
  });

  it("surfaces the typed partial-compensation error through runWorkflow", async () => {
    const workflowFailure = new Error("step failed");
    harness.registry.register(
      contribution(
        "reversible",
        "calendar",
        async () => "created",
        async () => {
          throw new Error("rollback failed");
        },
      ),
    );
    harness.registry.register(
      contribution("fails", "finance", async () => {
        throw workflowFailure;
      }),
    );
    const definition = makeDefinition([
      { kind: "reversible" },
      { kind: "fails" },
    ]);
    harness.getWorkflowDefinition.mockResolvedValue(definition);

    await expect(harness.domain.runWorkflow("wf-1")).rejects.toMatchObject({
      status: 500,
      code: "WORKFLOW_RUN_FAILED_UNCOMPENSATED",
      cause: workflowFailure,
      failedCompensationKinds: ["reversible"],
      run: expect.objectContaining({ status: "failed_uncompensated" }),
    });
    expect(harness.runs).toEqual([
      expect.objectContaining({ status: "failed_uncompensated" }),
    ]);
  });

  it("replays a run instead of re-executing when the idempotency key matches", async () => {
    const idempotencyKey = "schedule:wf-1:2026-08-20T09:00:00.000Z";
    const execute = vi.fn(async () => {
      expect(harness.runs).toEqual([
        expect.objectContaining({
          agentId: AGENT_ID,
          workflowId: "wf-1",
          idempotencyKey,
          status: "running",
          finishedAt: null,
        }),
      ]);
      expect(harness.repository.claimWorkflowRun).toHaveBeenCalledTimes(1);
      expect(harness.repository.completeWorkflowRun).not.toHaveBeenCalled();
      return { ok: true };
    });
    harness.registry.register(contribution("side_effect", "finance", execute));
    const definition = makeDefinition([
      { kind: "side_effect", resultKey: "out" },
    ]);

    const first = await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
      idempotencyKey,
    });
    const second = await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
      idempotencyKey,
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(
      harness.repository.claimWorkflowRun.mock.invocationCallOrder[0],
    ).toBeLessThan(execute.mock.invocationCallOrder[0] as number);
    expect(second.run.id).toBe(first.run.id);
    expect(second.error).toBeNull();
    expect(second.disposition).toBe("replayed");
    expect(harness.runs).toHaveLength(1);
    expect(first.run.idempotencyKey).toBe(idempotencyKey);
    expect(first.run.result.idempotencyKey).toBe(idempotencyKey);
    expect(
      harness.repository.getWorkflowRunByIdempotencyKey,
    ).toHaveBeenCalledWith(AGENT_ID, "wf-1", idempotencyKey);
    expect(harness.repository.listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("surfaces a prior failed run under the same key as a typed error without re-executing", async () => {
    const execute = vi.fn(async () => {
      throw new Error("side effect failed");
    });
    harness.registry.register(contribution("side_effect", "finance", execute));
    const definition = makeDefinition([{ kind: "side_effect" }]);

    const first = await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
      idempotencyKey: "schedule:wf-1:failing",
    });
    const second = await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
      idempotencyKey: "schedule:wf-1:failing",
    });

    expect(first.run.status).toBe("failed");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.run.id).toBe(first.run.id);
    expect(second.error).toBeInstanceOf(Error);
    expect(second.error).toMatchObject({
      status: 409,
      code: "WORKFLOW_RUN_ALREADY_FAILED",
    });
    expect(second.disposition).toBe("replayed");
    expect(harness.runs).toHaveLength(1);
    expect(harness.repository.listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("replays a partially compensated run with its typed terminal error", async () => {
    const idempotencyKey = "schedule:wf-1:partial";
    const prior = storedRun({
      id: "partial-run",
      idempotencyKey,
      status: "failed_uncompensated",
      result: {
        compensations: [
          {
            kind: "calendar_create",
            status: "compensation_failed",
            error: "delete failed",
          },
          { kind: "reminder_create", status: "compensated" },
        ],
      },
    });
    harness.runs.push(prior);
    const execute = vi.fn(async () => "must not execute");
    harness.registry.register(contribution("side_effect", "calendar", execute));

    const result = await harness.domain.executeWorkflowDefinition(
      makeDefinition([{ kind: "side_effect" }]),
      {
        startedAt: LATER,
        confirmBrowserActions: false,
        request: {},
        idempotencyKey,
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.run).toEqual(prior);
    expect(result.disposition).toBe("replayed");
    expect(result.error).toBeInstanceOf(
      LifeOpsWorkflowRunFailedUncompensatedError,
    );
    expect(result.error).toMatchObject({
      status: 409,
      code: "WORKFLOW_RUN_FAILED_UNCOMPENSATED",
      failedCompensationKinds: ["calendar_create"],
      run: prior,
    });
    expect(harness.repository.listWorkflowRuns).not.toHaveBeenCalled();
  });

  it.each(["running", "queued"] as const)(
    "does not re-execute a %s keyed run",
    async (status) => {
      const idempotencyKey = `schedule:wf-1:${status}`;
      const prior = storedRun({
        id: `${status}-run`,
        idempotencyKey,
        status,
      });
      harness.runs.push(prior);
      const execute = vi.fn(async () => "must not execute");
      harness.registry.register(
        contribution("side_effect", "calendar", execute),
      );

      const result = await harness.domain.executeWorkflowDefinition(
        makeDefinition([{ kind: "side_effect" }]),
        {
          startedAt: LATER,
          confirmBrowserActions: false,
          request: {},
          idempotencyKey,
        },
      );

      expect(execute).not.toHaveBeenCalled();
      expect(result.run).toEqual(prior);
      expect(result.disposition).toBe("in_progress");
      expect(result.error).toMatchObject({
        status: 409,
        code: "WORKFLOW_RUN_IN_PROGRESS",
      });
      expect(harness.repository.listWorkflowRuns).not.toHaveBeenCalled();
    },
  );

  it("does not advance a due scheduler cursor while its keyed run is already running", async () => {
    const previousDueAt = "2026-08-20T08:00:00.000Z";
    const previousRunId = "previous-scheduled-run";
    const schedulerState = {
      managedBy: "task_worker" as const,
      nextDueAt: NOW,
      lastDueAt: previousDueAt,
      lastRunId: previousRunId,
      lastRunStatus: "success" as const,
      updatedAt: previousDueAt,
    };
    const definition: LifeOpsWorkflowDefinition = {
      ...makeDefinition([{ kind: "side_effect" }]),
      triggerType: "schedule",
      schedule: { kind: "interval", everyMinutes: 60, timezone: "UTC" },
      metadata: { lifeopsScheduler: schedulerState },
    };
    const idempotencyKey = `schedule:wf-1:${NOW}`;
    harness.runs.push(
      storedRun({
        id: "already-running-scheduled-run",
        idempotencyKey,
        status: "running",
      }),
    );
    harness.repository.listWorkflows.mockResolvedValue([definition]);
    const execute = vi.fn(async () => "must not execute");
    harness.registry.register(contribution("side_effect", "calendar", execute));

    const runs = await harness.domain.runDueWorkflows({ now: NOW, limit: 1 });

    expect(runs).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(harness.emitWorkflowRunNudge).not.toHaveBeenCalled();
    expect(harness.repository.updateWorkflow).not.toHaveBeenCalled();
    expect(definition.metadata.lifeopsScheduler).toMatchObject({
      nextDueAt: NOW,
      lastDueAt: previousDueAt,
      lastRunId: previousRunId,
    });
    expect(harness.logLifeOpsWarn).toHaveBeenCalledWith(
      "workflow_scheduled_execution",
      "workflow run is already in progress; scheduler cursor was not advanced",
      {
        workflowId: "wf-1",
        workflowRunId: "already-running-scheduled-run",
        dueAt: NOW,
      },
    );
    expect(
      harness.repository.getWorkflowRunByIdempotencyKey,
    ).toHaveBeenCalledWith(AGENT_ID, "wf-1", idempotencyKey);
    expect(harness.repository.listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("does not advance an event cursor while its keyed run is already running", async () => {
    const previousEventAt = "2026-08-20T08:00:00.000Z";
    const schedulerState = {
      managedBy: "task_worker" as const,
      nextDueAt: null,
      lastDueAt: previousEventAt,
      lastRunId: "previous-event-run",
      lastRunStatus: "success" as const,
      updatedAt: previousEventAt,
      lastFiredEventEndAt: previousEventAt,
      lastFiredEventId: "previous-event",
    };
    const originalSchedulerState = structuredClone(schedulerState);
    const definition: LifeOpsWorkflowDefinition = {
      ...makeDefinition([{ kind: "side_effect" }]),
      triggerType: "event",
      schedule: { kind: "event", eventKind: "lifeops.wake.confirmed" },
      metadata: { lifeopsScheduler: schedulerState },
    };
    const eventId = "wake-confirmed-event";
    const idempotencyKey = `event:wf-1:${eventId}:${NOW}`;
    harness.runs.push(
      storedRun({
        id: "already-running-event-run",
        idempotencyKey,
        status: "running",
      }),
    );
    harness.repository.listWorkflows.mockResolvedValue([definition]);
    const execute = vi.fn(async () => "must not execute");
    harness.registry.register(contribution("side_effect", "calendar", execute));

    const runs = await harness.domain.runDueEventWorkflows({
      now: NOW,
      limit: 1,
      lifeOpsEvents: [
        {
          id: eventId,
          kind: "lifeops.wake.confirmed",
          occurredAt: NOW,
          confidence: 0.98,
          payload: { source: "wearable" },
        },
      ],
    });

    expect(runs).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(harness.repository.claimWorkflowRun).toHaveBeenCalledTimes(1);
    expect(harness.runs).toEqual([
      expect.objectContaining({
        id: "already-running-event-run",
        idempotencyKey,
        status: "running",
      }),
    ]);
    expect(harness.emitWorkflowRunNudge).not.toHaveBeenCalled();
    expect(harness.repository.updateWorkflow).not.toHaveBeenCalled();
    expect(definition.metadata.lifeopsScheduler).toEqual(
      originalSchedulerState,
    );
    expect(harness.logLifeOpsWarn).toHaveBeenCalledWith(
      "workflow_event_execution",
      "workflow run is already in progress; event cursor was not advanced",
      {
        workflowId: "wf-1",
        workflowRunId: "already-running-event-run",
        eventId,
        eventEndAt: NOW,
      },
    );
    expect(
      harness.repository.getWorkflowRunByIdempotencyKey,
    ).toHaveBeenCalledWith(AGENT_ID, "wf-1", idempotencyKey);
    expect(harness.repository.listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("surfaces a cancelled keyed run as terminal without re-executing", async () => {
    const idempotencyKey = "schedule:wf-1:cancelled";
    const prior = storedRun({
      id: "cancelled-run",
      idempotencyKey,
      status: "cancelled",
    });
    harness.runs.push(prior);
    const execute = vi.fn(async () => "must not execute");
    harness.registry.register(contribution("side_effect", "calendar", execute));

    const result = await harness.domain.executeWorkflowDefinition(
      makeDefinition([{ kind: "side_effect" }]),
      {
        startedAt: LATER,
        confirmBrowserActions: false,
        request: {},
        idempotencyKey,
      },
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.run).toEqual(prior);
    expect(result.disposition).toBe("replayed");
    expect(result.error).toMatchObject({
      status: 409,
      code: "WORKFLOW_RUN_CANCELLED",
    });
  });

  it("accepts a 256-character public idempotency key", async () => {
    harness.registry.register(
      contribution("noop", "calendar", async () => null),
    );
    const definition = makeDefinition([{ kind: "noop" }]);
    harness.getWorkflowDefinition.mockResolvedValue(definition);

    const run = await harness.domain.runWorkflow("wf-1", {
      idempotencyKey: "k".repeat(256),
    });

    expect(run.status).toBe("success");
    expect(run.idempotencyKey).toBe("k".repeat(256));
  });

  it("rejects a 257-character public idempotency key before claiming a run", async () => {
    harness.registry.register(
      contribution("noop", "calendar", async () => null),
    );
    const definition = makeDefinition([{ kind: "noop" }]);
    harness.getWorkflowDefinition.mockResolvedValue(definition);

    await expect(
      harness.domain.runWorkflow("wf-1", {
        idempotencyKey: "k".repeat(257),
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(harness.repository.claimWorkflowRun).not.toHaveBeenCalled();
  });

  it("rejects a NUL idempotency key before claiming a run", async () => {
    harness.registry.register(
      contribution("noop", "calendar", async () => null),
    );
    const definition = makeDefinition([{ kind: "noop" }]);
    harness.getWorkflowDefinition.mockResolvedValue(definition);

    await expect(
      harness.domain.runWorkflow("wf-1", {
        idempotencyKey: "unsafe\0key",
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(harness.repository.claimWorkflowRun).not.toHaveBeenCalled();
  });

  it("executes a distinct idempotency key as a new run", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    harness.registry.register(contribution("side_effect", "finance", execute));
    const definition = makeDefinition([{ kind: "side_effect" }]);

    await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
      idempotencyKey: "event:wf-1:e-1",
    });
    await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
      idempotencyKey: "event:wf-1:e-2",
    });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(harness.runs).toHaveLength(2);
    expect(harness.repository.listWorkflowRuns).not.toHaveBeenCalled();
  });

  it("runs the same workflow id independently across agents and preserves the captured agent", async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.registry.register(
      contribution("agent_a_slow", "calendar", async () => {
        events.push("agent-a:start");
        await gate;
        events.push("agent-a:end");
        return null;
      }),
    );
    harness.registry.register(
      contribution("agent_b_fast", "inbox", async () => {
        events.push("agent-b:run");
        return null;
      }),
    );

    harness.setAgentId(AGENT_ID);
    const firstRun = harness.domain.executeWorkflowDefinition(
      makeDefinition([{ kind: "agent_a_slow" }], { agentId: AGENT_ID }),
      {
        startedAt: NOW,
        confirmBrowserActions: false,
        request: {},
      },
    );
    harness.setAgentId(SECOND_AGENT_ID);
    const secondRun = harness.domain.executeWorkflowDefinition(
      makeDefinition([{ kind: "agent_b_fast" }], {
        agentId: SECOND_AGENT_ID,
      }),
      {
        startedAt: NOW,
        confirmBrowserActions: false,
        request: {},
      },
    );

    try {
      await vi.waitFor(
        () => {
          expect(events).toContain("agent-a:start");
          expect(events).toContain("agent-b:run");
          expect(events).not.toContain("agent-a:end");
        },
        { timeout: 250 },
      );
    } finally {
      release();
    }
    const [first, second] = await Promise.all([firstRun, secondRun]);

    expect(first.run.agentId).toBe(AGENT_ID);
    expect(second.run.agentId).toBe(SECOND_AGENT_ID);
    expect(events.indexOf("agent-b:run")).toBeLessThan(
      events.indexOf("agent-a:end"),
    );
    expect(harness.runs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: AGENT_ID, workflowId: "wf-1" }),
        expect.objectContaining({
          agentId: SECOND_AGENT_ID,
          workflowId: "wf-1",
        }),
      ]),
    );
  });

  it("serializes concurrent executions of the same workflow", async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.registry.register(
      contribution("slow", "calendar", async () => {
        events.push("slow:start");
        await gate;
        events.push("slow:end");
        return null;
      }),
    );
    harness.registry.register(
      contribution("fast", "inbox", async () => {
        events.push("fast:run");
        return null;
      }),
    );
    const slowDefinition = makeDefinition([{ kind: "slow" }]);
    const fastDefinition = {
      ...makeDefinition([{ kind: "fast" }]),
      id: "wf-1",
    };

    const firstRun = harness.domain.executeWorkflowDefinition(slowDefinition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
    });
    const secondRun = harness.domain.executeWorkflowDefinition(fastDefinition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(["slow:start"]);
    release();
    await Promise.all([firstRun, secondRun]);

    expect(events).toEqual(["slow:start", "slow:end", "fast:run"]);
    expect(harness.runs).toHaveLength(2);
  });

  it("continues serial execution after a failed run in the chain", async () => {
    harness.registry.register(
      contribution("fails", "finance", async () => {
        throw new Error("first fails");
      }),
    );
    harness.registry.register(
      contribution("succeeds", "reminders", async () => "ok"),
    );
    const failing = makeDefinition([{ kind: "fails" }]);
    const succeeding = makeDefinition([{ kind: "succeeds" }]);

    const first = await harness.domain.executeWorkflowDefinition(failing, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
    });
    const second = await harness.domain.executeWorkflowDefinition(succeeding, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
    });

    expect(first.run.status).toBe("failed");
    expect(second.run.status).toBe("success");
  });
});
