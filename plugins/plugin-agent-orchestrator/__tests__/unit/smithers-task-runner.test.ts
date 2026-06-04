import { describe, expect, it } from "vitest";
import { runTaskWithSmithers } from "../../src/services/smithers-task-runner";
import type {
  TaskApprovalResult,
  TaskProvisionResult,
  TaskRunSpec,
  TaskStepContext,
  TaskStepExecutor,
  TaskSubmitResult,
  TaskTurnResult,
} from "../../src/services/smithers-task-types";

const TIMEOUT = 60_000;

interface FakeOpts {
  doneOnTurn?: number; // per-agent turn at which runTurn reports done
  approved?: boolean;
  throwOnTurnCall?: number; // throw a fatal error on the Nth runTurn call
  abort?: { controller: AbortController; onCall: number }; // abort + hang on the Nth call
}

class FakeExecutor implements TaskStepExecutor {
  turnCalls: TaskStepContext[] = [];
  provisionCalls = 0;
  approvalCalls = 0;
  submitCalls = 0;

  constructor(private readonly opts: FakeOpts = {}) {}

  async provision(ctx: TaskStepContext): Promise<TaskProvisionResult> {
    this.provisionCalls += 1;
    return { workspace: { dir: `/tmp/ws-${ctx.taskId}` } };
  }

  async runTurn(ctx: TaskStepContext): Promise<TaskTurnResult> {
    this.turnCalls.push(ctx);
    const call = this.turnCalls.length;
    if (this.opts.throwOnTurnCall && call === this.opts.throwOnTurnCall) {
      throw new Error("fatal turn failure");
    }
    if (this.opts.abort && call >= this.opts.abort.onCall) {
      this.opts.abort.controller.abort();
      await new Promise<never>(() => {}); // hang until SIGKILL
    }
    const done = this.opts.doneOnTurn
      ? (ctx.turn ?? 0) >= this.opts.doneOnTurn
      : false;
    return { done };
  }

  async requestApproval(_ctx: TaskStepContext): Promise<TaskApprovalResult> {
    this.approvalCalls += 1;
    return { approved: this.opts.approved !== false };
  }

  async submit(ctx: TaskStepContext): Promise<TaskSubmitResult> {
    this.submitCalls += 1;
    return { output: { pr: `https://pr/${ctx.taskId}` } };
  }
}

function spec(overrides: Partial<TaskRunSpec> = {}): TaskRunSpec {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  return { taskId: id, runId: id, initialPrompt: "do the thing", ...overrides };
}

describe("runTaskWithSmithers (durable Smithers-backed coding task)", () => {
  it(
    "completes a single-turn task",
    async () => {
      const fake = new FakeExecutor({ doneOnTurn: 1 });
      const result = await runTaskWithSmithers(spec(), fake);
      expect(result.status).toBe("completed");
      expect(result.turns).toBe(1);
      expect(fake.turnCalls).toHaveLength(1);
      expect(result.agentsDone).toEqual([true]);
    },
    TIMEOUT,
  );

  it(
    "loops agent turns until done",
    async () => {
      const fake = new FakeExecutor({ doneOnTurn: 3 });
      const result = await runTaskWithSmithers(spec(), fake);
      expect(result.status).toBe("completed");
      expect(result.turns).toBe(3);
      expect(fake.turnCalls.map((c) => c.turn)).toEqual([1, 2, 3]);
    },
    TIMEOUT,
  );

  it(
    "stops at maxTurns and reports incomplete when never done",
    async () => {
      const fake = new FakeExecutor({ doneOnTurn: 999 });
      const result = await runTaskWithSmithers(spec({ maxTurns: 3 }), fake);
      expect(result.status).toBe("incomplete");
      expect(result.turns).toBe(3);
      expect(result.agentsDone).toEqual([false]);
    },
    TIMEOUT,
  );

  it(
    "runs provision + approval(approved) + submit",
    async () => {
      const fake = new FakeExecutor({ doneOnTurn: 1, approved: true });
      const result = await runTaskWithSmithers(
        spec({ provision: true, submit: true, approvalBeforeSubmit: true }),
        fake,
      );
      expect(result.status).toBe("completed");
      expect(fake.provisionCalls).toBe(1);
      expect(fake.approvalCalls).toBe(1);
      expect(fake.submitCalls).toBe(1);
      expect(result.workspace).toMatchObject({
        dir: expect.stringContaining("/tmp/ws-"),
      });
      expect(result.submit).toMatchObject({
        pr: expect.stringContaining("https://pr/"),
      });
    },
    TIMEOUT,
  );

  it(
    "skips submit and reports denied when approval is denied",
    async () => {
      const fake = new FakeExecutor({ doneOnTurn: 1, approved: false });
      const result = await runTaskWithSmithers(
        spec({ submit: true, approvalBeforeSubmit: true }),
        fake,
      );
      expect(result.status).toBe("denied");
      expect(result.approved).toBe(false);
      expect(fake.submitCalls).toBe(0);
      expect(result.submit).toBeUndefined();
    },
    TIMEOUT,
  );

  it(
    "fans out parallel agents and completes when all are done",
    async () => {
      const fake = new FakeExecutor({ doneOnTurn: 2 });
      const result = await runTaskWithSmithers(
        spec({ parallelAgents: 2 }),
        fake,
      );
      expect(result.status).toBe("completed");
      expect(result.agentsDone).toEqual([true, true]);
      // 2 agents × 2 turns each.
      expect(fake.turnCalls).toHaveLength(4);
      expect(fake.turnCalls.filter((c) => c.agentIndex === 0)).toHaveLength(2);
      expect(fake.turnCalls.filter((c) => c.agentIndex === 1)).toHaveLength(2);
    },
    TIMEOUT,
  );

  it(
    "propagates a fatal turn failure as a rejection",
    async () => {
      const fake = new FakeExecutor({ throwOnTurnCall: 1 });
      await expect(runTaskWithSmithers(spec(), fake)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    "durably resumes after a crash, skipping completed turns",
    async () => {
      const shared = spec({ maxTurns: 10 });
      // Run 1: completes turns 1 & 2, then aborts (SIGKILL) while turn 3 is in flight.
      const controller = new AbortController();
      const run1 = new FakeExecutor({
        doneOnTurn: 999,
        abort: { controller, onCall: 3 },
      });
      await expect(
        runTaskWithSmithers(shared, run1, { signal: controller.signal }),
      ).rejects.toThrow();
      expect(run1.turnCalls.length).toBeGreaterThanOrEqual(2);

      // Run 2: same runId resumes; completed turns 1 & 2 are NOT re-run. The fresh
      // executor finishes on its first (resumed) turn, so it sees exactly one turn.
      const run2 = new FakeExecutor({ doneOnTurn: 1 });
      const result = await runTaskWithSmithers(shared, run2);
      expect(result.status).toBe("completed");
      expect(run2.turnCalls).toHaveLength(1); // turns 1 & 2 were durably skipped
    },
    TIMEOUT,
  );
});
