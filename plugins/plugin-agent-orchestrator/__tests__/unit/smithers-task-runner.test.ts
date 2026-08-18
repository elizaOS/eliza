/**
 * Verifies runTaskWithSmithers (durable Smithers-backed coding task).
 * Integration-backed test of the real Smithers subprocess and deterministic
 * executor doubles; no runtime or live model.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  malformedApproval?: boolean; // requestApproval returns a result missing `approved`
  throwOnTurnCall?: number; // throw a fatal error on the Nth runTurn call
  hangOnTurnCall?: number;
  delayOnTurnMs?: number;
  abort?: { controller: AbortController; onCall: number }; // abort + hang on the Nth call
}

class FakeExecutor implements TaskStepExecutor {
  turnCalls: TaskStepContext[] = [];
  cancellationSignals = 0;
  provisionCalls = 0;
  approvalCalls = 0;
  submitCalls = 0;

  constructor(private readonly opts: FakeOpts = {}) {}

  private waitForCancellation(ctx: TaskStepContext): Promise<never> {
    return new Promise((_, reject) => {
      const cancel = (): void => {
        this.cancellationSignals += 1;
        reject(new Error("cancelled by runner"));
      };
      if (ctx.signal?.aborted) cancel();
      else ctx.signal?.addEventListener("abort", cancel, { once: true });
    });
  }

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
      await this.waitForCancellation(ctx);
    }
    if (this.opts.hangOnTurnCall && call >= this.opts.hangOnTurnCall) {
      await this.waitForCancellation(ctx);
    }
    if (this.opts.delayOnTurnMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.opts.delayOnTurnMs),
      );
    }
    const done = this.opts.doneOnTurn
      ? (ctx.turn ?? 0) >= this.opts.doneOnTurn
      : false;
    return { done };
  }

  async requestApproval(_ctx: TaskStepContext): Promise<TaskApprovalResult> {
    this.approvalCalls += 1;
    if (this.opts.malformedApproval) {
      // Simulate a broken handler that omits `approved` at the untyped
      // subprocess boundary.
      return {} as unknown as TaskApprovalResult;
    }
    return { approved: this.opts.approved !== false };
  }

  async submit(ctx: TaskStepContext): Promise<TaskSubmitResult> {
    this.submitCalls += 1;
    return { output: { pr: `https://pr/${ctx.taskId}` } };
  }
}

function spec(overrides: Partial<TaskRunSpec> = {}): TaskRunSpec {
  const id = `task-${Math.random().toString(36).slice(2, 10)}`;
  return {
    tenantId: "00000000-0000-4000-8000-000000000001",
    taskId: id,
    runId: id,
    initialPrompt: "do the thing",
    ...overrides,
  };
}

describe("runTaskWithSmithers (durable Smithers-backed coding task)", () => {
  it(
    "isolates concurrent PGlite workers beneath one configured data root",
    async () => {
      const dataRoot = await mkdtemp(
        join(tmpdir(), "smithers-pglite-workers-"),
      );
      const previousProvider = process.env.SMITHERS_DB_PROVIDER;
      const previousDataDir = process.env.SMITHERS_DB_DATA_DIR;
      process.env.SMITHERS_DB_PROVIDER = "pglite";
      process.env.SMITHERS_DB_DATA_DIR = dataRoot;
      try {
        const [first, second] = await Promise.all([
          runTaskWithSmithers(
            spec({ taskId: "concurrent-a", runId: "run-a" }),
            new FakeExecutor({ doneOnTurn: 1, delayOnTurnMs: 250 }),
          ),
          runTaskWithSmithers(
            spec({ taskId: "concurrent-b", runId: "run-b" }),
            new FakeExecutor({ doneOnTurn: 1, delayOnTurnMs: 250 }),
          ),
        ]);
        expect(first.status).toBe("completed");
        expect(second.status).toBe("completed");
      } finally {
        if (previousProvider === undefined)
          delete process.env.SMITHERS_DB_PROVIDER;
        else process.env.SMITHERS_DB_PROVIDER = previousProvider;
        if (previousDataDir === undefined)
          delete process.env.SMITHERS_DB_DATA_DIR;
        else process.env.SMITHERS_DB_DATA_DIR = previousDataDir;
        await rm(dataRoot, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );

  it(
    "completes a single-turn task",
    async () => {
      const fake = new FakeExecutor({ doneOnTurn: 1 });
      const result = await runTaskWithSmithers(spec(), fake);
      expect(result.status).toBe("completed");
      expect(result.turns).toBe(1);
      expect(fake.turnCalls).toHaveLength(1);
      expect(fake.turnCalls[0]?.signal).toBeInstanceOf(AbortSignal);
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
    "fails closed (skips submit) when a present approval handler returns a malformed result (#11028)",
    async () => {
      // A handler that omits `approved` must NOT be treated as approval — a
      // broken approval gate should hold the submit, not silently release it.
      const fake = new FakeExecutor({ doneOnTurn: 1, malformedApproval: true });
      const result = await runTaskWithSmithers(
        spec({ submit: true, approvalBeforeSubmit: true }),
        fake,
      );
      expect(fake.approvalCalls).toBe(1);
      expect(result.approved).toBe(false);
      expect(fake.submitCalls).toBe(0);
      expect(result.status).toBe("denied");
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

  it("rejects an invalid deadline before executing any task step", async () => {
    const fake = new FakeExecutor();

    await expect(
      runTaskWithSmithers(spec(), fake, { timeoutMs: 0 }),
    ).rejects.toMatchObject({
      name: "ElizaError",
      code: "SMITHERS_TIMEOUT_INVALID",
      context: {
        configured: 0,
        minimum: 1,
        maximum: 2_147_483_647,
      },
    });
    expect(fake.provisionCalls).toBe(0);
    expect(fake.turnCalls).toHaveLength(0);
    expect(fake.approvalCalls).toBe(0);
    expect(fake.submitCalls).toBe(0);
  });

  it(
    "kills a stalled Smithers task at the configured execution deadline",
    async () => {
      const fake = new FakeExecutor({ hangOnTurnCall: 1 });
      await expect(
        runTaskWithSmithers(spec(), fake, { timeoutMs: 5_000 }),
      ).rejects.toMatchObject({
        name: "ElizaError",
        code: "SMITHERS_TASK_TIMEOUT",
      });
      expect(fake.turnCalls).toHaveLength(1);
      expect(fake.cancellationSignals).toBe(1);
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

      // Run 2: same runId resumes; completed turns 1 & 2 are NOT re-run. Smithers'
      // persisted iteration makes the next delegated context absolute turn 3,
      // even though this is the fresh executor's first call.
      const run2 = new FakeExecutor({ doneOnTurn: 3 });
      const result = await runTaskWithSmithers(shared, run2);
      expect(result.status).toBe("completed");
      expect(run2.turnCalls).toHaveLength(1); // turns 1 & 2 were durably skipped
      expect(run2.turnCalls[0]?.turn).toBe(3);
      expect(result.turns).toBe(3);
      expect(result.metrics.turns).toBe(3);

      const run3 = new FakeExecutor({ doneOnTurn: 999 });
      const fullyResumed = await runTaskWithSmithers(shared, run3);
      expect(run3.turnCalls).toHaveLength(0);
      expect(fullyResumed.turns).toBe(result.turns);
      expect(fullyResumed.metrics.turns).toBe(result.metrics.turns);
    },
    TIMEOUT,
  );

  it(
    "recovers provision, approval, and submit outputs on identical resume",
    async () => {
      const shared = spec({
        provision: true,
        approvalBeforeSubmit: true,
        submit: true,
        maxTurns: 1,
      });
      const firstExecutor = new FakeExecutor({
        doneOnTurn: 1,
        approved: true,
      });
      const first = await runTaskWithSmithers(shared, firstExecutor);
      expect(first).toMatchObject({
        status: "completed",
        approved: true,
        workspace: { dir: expect.stringContaining("/tmp/ws-") },
        submit: { pr: expect.stringContaining("https://pr/") },
      });

      const resumedExecutor = new FakeExecutor({
        doneOnTurn: 1,
        approved: false,
      });
      const resumed = await runTaskWithSmithers(shared, resumedExecutor);
      expect(resumed).toMatchObject({
        status: "completed",
        approved: true,
        workspace: first.workspace,
        submit: first.submit,
      });
      expect(resumedExecutor.turnCalls).toHaveLength(0);
      expect(resumedExecutor.provisionCalls).toBe(0);
      expect(resumedExecutor.approvalCalls).toBe(0);
      expect(resumedExecutor.submitCalls).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "keeps denial fail-closed across resume and incompatible spec evolution",
    async () => {
      const deniedSpec = spec({
        approvalBeforeSubmit: true,
        submit: false,
        maxTurns: 1,
      });
      const firstExecutor = new FakeExecutor({
        doneOnTurn: 1,
        approved: false,
      });
      const first = await runTaskWithSmithers(deniedSpec, firstExecutor);
      expect(first.status).toBe("denied");
      expect(firstExecutor.approvalCalls).toBe(1);

      const resumedExecutor = new FakeExecutor({
        doneOnTurn: 1,
        approved: true,
      });
      const resumed = await runTaskWithSmithers(deniedSpec, resumedExecutor);
      expect(resumed.status).toBe("denied");
      expect(resumed.approved).toBe(false);
      expect(resumedExecutor.turnCalls).toHaveLength(0);
      expect(resumedExecutor.approvalCalls).toBe(0);

      const evolvedExecutor = new FakeExecutor({
        doneOnTurn: 1,
        approved: false,
      });
      const evolved = await runTaskWithSmithers(
        { ...deniedSpec, submit: true },
        evolvedExecutor,
      );
      expect(evolved.status).toBe("denied");
      expect(evolvedExecutor.approvalCalls).toBe(1);
      expect(evolvedExecutor.submitCalls).toBe(0);
    },
    TIMEOUT,
  );
});
