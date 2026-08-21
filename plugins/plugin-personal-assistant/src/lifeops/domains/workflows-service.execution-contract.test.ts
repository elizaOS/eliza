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
import { type WorkflowsDeps, WorkflowsDomain } from "./workflows-service.js";

const AGENT_ID = "00000000-0000-0000-0000-0000000000aa";
const NOW = "2026-08-20T09:00:00.000Z";

function makeDefinition(
  steps: Array<Record<string, unknown>>,
): LifeOpsWorkflowDefinition {
  return {
    id: "wf-1",
    agentId: AGENT_ID,
    domain: "personal",
    subjectType: "owner",
    subjectId: "owner-1",
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
  logLifeOpsError: ReturnType<typeof vi.fn>;
  getWorkflowDefinition: ReturnType<typeof vi.fn>;
};

function makeHarness(): Harness {
  const runtime = { agentId: AGENT_ID };
  const registry = createWorkflowStepRegistry();
  registerWorkflowStepRegistry(
    runtime as unknown as Parameters<typeof registerWorkflowStepRegistry>[0],
    registry,
  );
  const runs: LifeOpsWorkflowRun[] = [];
  const logLifeOpsError = vi.fn();
  const ctx = {
    runtime,
    repository: {
      createWorkflowRun: vi.fn(async (run: LifeOpsWorkflowRun) => {
        runs.push(run);
      }),
      listWorkflowRuns: vi.fn(async () => [...runs]),
    },
    agentId: () => AGENT_ID,
    logLifeOpsError,
  };
  const deps = {
    recordWorkflowAudit: vi.fn(
      async (): Promise<LifeOpsAuditEvent> =>
        ({ id: `audit-${runs.length}` }) as LifeOpsAuditEvent,
    ),
    getWorkflowDefinition: vi.fn(),
    readEffectiveScheduleState: vi.fn(async () => null),
    emitWorkflowRunNudge: vi.fn(async () => undefined),
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
    logLifeOpsError,
    getWorkflowDefinition: deps.getWorkflowDefinition,
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
        throw new Error("upstream unavailable");
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
    expect(result.error).toBeInstanceOf(Error);
    expect(order).toEqual(["undo_event", "undo_reminder:r-1"]);
    expect(result.run.result.compensations).toEqual([
      { kind: "create_event", status: "compensated" },
      { kind: "create_reminder", status: "compensated" },
    ]);
  });

  it("records a compensation failure without aborting remaining compensations", async () => {
    const order: string[] = [];
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
          throw new Error("undo failed");
        },
      ),
    );
    harness.registry.register(
      contribution("step_c", "finance", async () => {
        throw new Error("boom");
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

    expect(order).toEqual(["undo_a"]);
    expect(result.run.result.compensations).toEqual([
      { kind: "step_b", status: "compensation_failed", error: "undo failed" },
      { kind: "step_a", status: "compensated" },
    ]);
    expect(harness.logLifeOpsError).toHaveBeenCalledWith(
      "workflow_step_compensation",
      expect.any(Error),
      expect.objectContaining({ stepKind: "step_b" }),
    );
  });

  it("replays a run instead of re-executing when the idempotency key matches", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    harness.registry.register(contribution("side_effect", "finance", execute));
    const definition = makeDefinition([
      { kind: "side_effect", resultKey: "out" },
    ]);

    const first = await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
      idempotencyKey: "schedule:wf-1:2026-08-20T09:00:00.000Z",
    });
    const second = await harness.domain.executeWorkflowDefinition(definition, {
      startedAt: NOW,
      confirmBrowserActions: false,
      request: {},
      idempotencyKey: "schedule:wf-1:2026-08-20T09:00:00.000Z",
    });

    expect(execute).toHaveBeenCalledTimes(1);
    expect(second.run.id).toBe(first.run.id);
    expect(second.error).toBeNull();
    expect(harness.runs).toHaveLength(1);
    expect(first.run.result.idempotencyKey).toBe(
      "schedule:wf-1:2026-08-20T09:00:00.000Z",
    );
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
    expect((second.error as Error).message).toContain("already failed");
    expect(harness.runs).toHaveLength(1);
  });

  it("rejects an oversized public idempotency key", async () => {
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
