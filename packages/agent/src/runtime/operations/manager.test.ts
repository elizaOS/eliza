/**
 * Unit coverage for DefaultRuntimeOperationManager. Drives the real manager
 * against a real in-memory RuntimeOperationRepository: start outcome kinds
 * and their precedence, prepare/classify-context ordering, the asynchronous
 * phase lifecycle, every failure-code branch, and single-flight rejection.
 */

import type { AgentRuntime } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import type { ClassifyContext } from "./classifier.ts";
import type { HealthChecker } from "./health.ts";
import { DefaultRuntimeOperationManager } from "./manager.ts";
import type {
  OperationIntent,
  OperationPhase,
  ReloadStrategy,
  RuntimeOperation,
  RuntimeOperationListOptions,
  RuntimeOperationRepository,
} from "./types.ts";

function makeRuntime(id: string): AgentRuntime {
  return { agentId: id } as AgentRuntime;
}

function makeRepository(
  seed: RuntimeOperation[] = [],
): RuntimeOperationRepository & { ops: RuntimeOperation[] } {
  const ops = [...seed];
  const find = (id: string) => ops.find((op) => op.id === id);
  return {
    ops,
    async create(op) {
      ops.push(structuredClone(op));
    },
    async update(id, patch) {
      const op = find(id);
      if (!op) throw new Error(`missing op ${id}`);
      Object.assign(op, structuredClone(patch));
    },
    async appendPhase(id, phase) {
      const op = find(id);
      if (!op) throw new Error(`missing op ${id}`);
      op.phases.push(structuredClone(phase));
    },
    async updateLastPhase(id, patch) {
      const op = find(id);
      if (!op) throw new Error(`missing op ${id}`);
      const last = op.phases.at(-1);
      if (!last) throw new Error(`op ${id} has no phases`);
      Object.assign(last, structuredClone(patch));
    },
    async get(id) {
      const op = find(id);
      return op ? structuredClone(op) : null;
    },
    async list(opts?: RuntimeOperationListOptions) {
      const filtered = opts?.status
        ? ops.filter((op) => op.status === opts.status)
        : ops;
      return filtered.map((op) => structuredClone(op));
    },
    async findByIdempotencyKey(key) {
      const op = [...ops].reverse().find((o) => o.idempotencyKey === key);
      return op ? structuredClone(op) : null;
    },
    async findActive() {
      const op = ops.find(
        (o) => o.status === "pending" || o.status === "running",
      );
      return op ? structuredClone(op) : null;
    },
  };
}

type RepoFixture = ReturnType<typeof makeRepository>;

interface Harness {
  repo: RepoFixture;
  manager: DefaultRuntimeOperationManager;
}

function makeHarness(options?: {
  seed?: RuntimeOperation[];
  runtime?: AgentRuntime | null;
  strategies?: Partial<Record<string, ReloadStrategy>>;
  healthReport?: Awaited<ReturnType<HealthChecker["runForRuntime"]>>;
  classifier?: (intent: OperationIntent, ctx: ClassifyContext) => string;
  classifyContext?: () => ClassifyContext;
}): Harness & {
  strategies: Partial<Record<string, ReloadStrategy>>;
} {
  const repo = makeRepository(options?.seed ?? []);
  const strategies = options?.strategies ?? {};
  const healthChecker = makeHealthChecker(async () =>
    options?.healthReport
      ? options.healthReport
      : {
          ok: true,
          passed: [{ name: "database-liveness", durationMs: 1 }],
          failed: [],
        },
  );
  const manager = new DefaultRuntimeOperationManager({
    repository: repo,
    runtime: () => options?.runtime ?? null,
    classifyContext:
      options?.classifyContext ??
      ((): ClassifyContext => ({ currentProvider: "openai" })),
    ...(options?.classifier ? { classifier: options.classifier as never } : {}),
    healthChecker,
    strategies: strategies as never,
  });
  return { repo, manager, strategies };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

type HealthCheckReport = Awaited<ReturnType<HealthChecker["runForRuntime"]>>;

function makeHealthChecker(
  run: (runtime: AgentRuntime) => Promise<HealthCheckReport>,
): HealthChecker {
  const stub = {
    async runForRuntime(runtime: AgentRuntime): Promise<HealthCheckReport> {
      return run(runtime);
    },
  };
  return stub as unknown as HealthChecker;
}

const restartIntent: OperationIntent = { kind: "restart", reason: "manual" };

function hotStrategy(apply: ReloadStrategy["apply"]): ReloadStrategy {
  return { tier: "hot", apply };
}

describe("DefaultRuntimeOperationManager.start", () => {
  describe("accepted", () => {
    it("persists the accepted operation synchronously as pending", async () => {
      const { repo, manager } = makeHarness();
      const outcome = await manager.start({ intent: restartIntent });

      expect(outcome.kind).toBe("accepted");
      if (outcome.kind !== "accepted") return;
      const { operation } = outcome;
      expect(operation.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(operation.kind).toBe("restart");
      expect(operation.intent).toEqual(restartIntent);
      expect(operation.tier).toBe("cold");
      expect(operation.status).toBe("pending");
      expect(operation.phases).toEqual([]);
      expect(typeof operation.startedAt).toBe("number");

      const stored = await repo.get(operation.id);
      expect(stored?.id).toBe(operation.id);
    });

    it("uses the conservative cold tier when no classifier is wired", async () => {
      const { manager } = makeHarness();
      const outcome = await manager.start({
        intent: { kind: "provider-switch", provider: "openai" },
      });
      expect(outcome.kind).toBe("accepted");
      if (outcome.kind !== "accepted") return;
      expect(outcome.operation.tier).toBe("cold");
    });

    it("records the custom classifier's tier on the persisted operation", async () => {
      const { repo, manager } = makeHarness({
        classifier: () => "warm",
        strategies: {},
      });
      const outcome = await manager.start({ intent: restartIntent });
      expect(outcome.kind).toBe("accepted");
      if (outcome.kind !== "accepted") return;
      expect(outcome.operation.tier).toBe("warm");
      expect((await repo.get(outcome.operation.id))?.tier).toBe("warm");
    });
  });

  describe("deduped", () => {
    it("returns the existing operation for a known idempotency key", async () => {
      const existing: RuntimeOperation = {
        id: "11111111-1111-4111-8111-111111111111",
        kind: "restart",
        intent: restartIntent,
        tier: "cold",
        idempotencyKey: "retry-1",
        status: "succeeded",
        phases: [],
        startedAt: 1,
      };
      const { manager } = makeHarness({ seed: [existing] });

      const outcome = await manager.start({
        intent: restartIntent,
        idempotencyKey: "retry-1",
      });

      expect(outcome.kind).toBe("deduped");
      if (outcome.kind !== "deduped") return;
      expect(outcome.operation.id).toBe(existing.id);
    });

    it("checks idempotency before the busy gate", async () => {
      const active: RuntimeOperation = {
        id: "22222222-2222-4222-8222-222222222222",
        kind: "restart",
        intent: restartIntent,
        tier: "cold",
        status: "running",
        phases: [],
        startedAt: 1,
      };
      const done: RuntimeOperation = {
        ...active,
        id: "33333333-3333-4333-8333-333333333333",
        idempotencyKey: "retry-2",
        status: "succeeded",
      };
      const { manager } = makeHarness({ seed: [active, done] });

      const outcome = await manager.start({
        intent: restartIntent,
        idempotencyKey: "retry-2",
      });

      expect(outcome.kind).toBe("deduped");
    });
  });

  describe("rejected-busy", () => {
    it("rejects with the active operation id", async () => {
      const active: RuntimeOperation = {
        id: "44444444-4444-4444-8444-444444444444",
        kind: "config-reload",
        intent: { kind: "config-reload" },
        tier: "hot",
        status: "running",
        phases: [],
        startedAt: 1,
      };
      const { manager } = makeHarness({ seed: [active] });

      const outcome = await manager.start({
        intent: restartIntent,
        idempotencyKey: "unused-key",
      });

      expect(outcome).toEqual({
        kind: "rejected-busy",
        activeOperationId: active.id,
      });
    });

    it("serializes concurrent submissions through the single-flight gate", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const { manager } = makeHarness({
        runtime: makeRuntime("rt-live"),
        strategies: {
          cold: hotStrategy(async () => {
            await gate;
            return makeRuntime("rt-next");
          }),
        },
      });

      const first = await manager.start({ intent: restartIntent });
      expect(first.kind).toBe("accepted");
      await settle();

      const second = await manager.start({ intent: restartIntent });
      expect(second.kind).toBe("rejected-busy");
      if (first.kind !== "accepted" || second.kind !== "rejected-busy") return;
      expect(second.activeOperationId).toBe(first.operation.id);

      release();
      await settle();
      const settled = await manager.get(first.operation.id);
      expect(settled?.status).toBe("succeeded");
    });
  });

  describe("prepare and classification ordering", () => {
    it("classifies against the context snapshot taken before prepare mutates state", async () => {
      const providerState = { value: "openai" };
      const seenAtClassification: string[] = [];
      const { manager } = makeHarness({
        classifyContext: () => ({ currentProvider: providerState.value }),
        classifier: (_intent, ctx) => {
          seenAtClassification.push(ctx.currentProvider ?? "");
          return "hot";
        },
        strategies: {
          hot: hotStrategy(async () => makeRuntime("rt")),
        },
      });

      await manager.start({
        intent: restartIntent,
        prepare: async () => {
          providerState.value = "cerebras";
          return undefined;
        },
      });
      await settle();
      expect(seenAtClassification).toEqual(["openai"]);

      await manager.start({ intent: restartIntent });
      expect(seenAtClassification).toEqual(["openai", "cerebras"]);
    });

    it("replaces the intent with prepare's returned payload", async () => {
      const seenIntents: OperationIntent[] = [];
      const { repo, manager } = makeHarness({
        runtime: makeRuntime("rt-live"),
        classifier: (intent) => {
          seenIntents.push(intent);
          return "hot";
        },
        strategies: {
          hot: hotStrategy(async ({ intent }) => {
            seenIntents.push(intent);
            return makeRuntime("rt");
          }),
        },
      });
      const replacement: OperationIntent = {
        kind: "plugin-enable",
        pluginId: "plugin-sql",
      };

      const outcome = await manager.start({
        intent: restartIntent,
        prepare: async () => replacement,
      });

      expect(outcome.kind).toBe("accepted");
      await settle();
      expect(seenIntents[0]).toEqual(replacement);
      expect(seenIntents[1]).toEqual(replacement);
      expect(repo.ops[0]?.kind).toBe("plugin-enable");
    });

    it("keeps the request intent when prepare resolves undefined", async () => {
      const { repo, manager } = makeHarness();
      const outcome = await manager.start({
        intent: restartIntent,
        prepare: async () => undefined,
      });
      expect(outcome.kind).toBe("accepted");
      expect(repo.ops[0]?.intent).toEqual(restartIntent);
    });
  });
});

describe("DefaultRuntimeOperationManager execution lifecycle", () => {
  it("runs validate, strategy and health-check to success", async () => {
    const liveRuntime = makeRuntime("rt-live");
    const nextRuntime = makeRuntime("rt-next");
    const appliedContexts: Array<{
      runtime: AgentRuntime;
      intent: OperationIntent;
    }> = [];
    const healthTargets: AgentRuntime[] = [];
    const repo = makeRepository();
    const manager = new DefaultRuntimeOperationManager({
      repository: repo,
      runtime: () => liveRuntime,
      classifyContext: () => ({}),
      healthChecker: makeHealthChecker(async (runtime) => {
        healthTargets.push(runtime);
        return {
          ok: true,
          passed: [
            { name: "database-liveness", durationMs: 2 },
            { name: "provider-ready", durationMs: 3 },
          ],
          failed: [],
        };
      }),
      strategies: {
        cold: hotStrategy(async (ctx) => {
          appliedContexts.push({
            runtime: ctx.runtime,
            intent: ctx.intent,
          });
          await ctx.reportPhase({
            name: "apply-env",
            status: "succeeded",
            startedAt: 1,
            finishedAt: 2,
          });
          return nextRuntime;
        }),
      },
    });

    const outcome = await manager.start({
      intent: { kind: "config-reload", changedPaths: ["env.KEY"] },
    });
    expect(outcome.kind).toBe("accepted");
    await settle();

    expect(appliedContexts).toHaveLength(1);
    expect(appliedContexts[0].runtime).toBe(liveRuntime);
    expect(appliedContexts[0].intent).toEqual({
      kind: "config-reload",
      changedPaths: ["env.KEY"],
    });
    expect(healthTargets).toEqual([nextRuntime]);

    const stored = repo.ops[0];
    expect(stored.status).toBe("succeeded");
    expect(stored.error).toBeUndefined();
    expect(stored.finishedAt).toBeGreaterThanOrEqual(stored.startedAt);
    expect(stored.phases.map((phase) => [phase.name, phase.status])).toEqual([
      ["validate", "succeeded"],
      ["apply-env", "succeeded"],
      ["health-check", "succeeded"],
    ]);
    const healthPhase = stored.phases.at(-1) as OperationPhase;
    expect(healthPhase.detail).toEqual({
      passed: [
        { name: "database-liveness", durationMs: 2 },
        { name: "provider-ready", durationMs: 3 },
      ],
      failed: [],
    });
    expect(healthPhase.finishedAt).toBeGreaterThanOrEqual(
      healthPhase.startedAt ?? 0,
    );
  });

  it("fails with no-strategy-for-tier when the tier has no strategy", async () => {
    const { repo, manager } = makeHarness({ runtime: makeRuntime("rt") });

    const outcome = await manager.start({ intent: restartIntent });
    expect(outcome.kind).toBe("accepted");
    await settle();

    const stored = repo.ops[0];
    expect(stored.status).toBe("failed");
    expect(stored.error).toEqual({
      message: "No strategy registered for tier=cold",
      code: "no-strategy-for-tier",
    });
    expect(stored.finishedAt).toBeDefined();
    expect(stored.phases.map((p) => [p.name, p.status])).toEqual([
      ["validate", "succeeded"],
    ]);
  });

  it("fails with no-runtime when no live runtime is available", async () => {
    const { repo, manager } = makeHarness({
      runtime: null,
      strategies: { cold: hotStrategy(async () => makeRuntime("rt")) },
    });

    await manager.start({ intent: restartIntent });
    await settle();

    expect(repo.ops[0].status).toBe("failed");
    expect(repo.ops[0].error).toMatchObject({
      code: "no-runtime",
      message: "No live runtime available to apply operation",
    });
  });

  it("checks the strategy registry before the runtime lookup", async () => {
    const { repo, manager } = makeHarness({
      runtime: null,
      strategies: {},
    });

    await manager.start({ intent: restartIntent });
    await settle();

    expect(repo.ops[0].error?.code).toBe("no-strategy-for-tier");
  });

  it("maps a plain strategy throw to strategy-failed", async () => {
    const { repo, manager } = makeHarness({
      runtime: makeRuntime("rt"),
      strategies: {
        cold: hotStrategy(async () => {
          throw new Error("boot exploded");
        }),
      },
    });

    await manager.start({ intent: restartIntent });
    await settle();

    expect(repo.ops[0].status).toBe("failed");
    expect(repo.ops[0].error).toEqual({
      message: "boot exploded",
      code: "strategy-failed",
    });
  });

  it("preserves vault-resolve-failed thrown codes", async () => {
    const { repo, manager } = makeHarness({
      runtime: makeRuntime("rt"),
      strategies: {
        cold: hotStrategy(async () => {
          throw Object.assign(new Error("vault miss"), {
            code: "vault-resolve-failed",
          });
        }),
      },
    });

    await manager.start({ intent: restartIntent });
    await settle();

    expect(repo.ops[0].error).toEqual({
      message: "vault miss",
      code: "vault-resolve-failed",
    });
  });

  it("fails with health-check-failed and marks only the last phase failed", async () => {
    const repo = makeRepository();
    const manager = new DefaultRuntimeOperationManager({
      repository: repo,
      runtime: () => makeRuntime("rt-live"),
      classifyContext: () => ({}),
      healthChecker: makeHealthChecker(async () => ({
        ok: false,
        passed: [],
        failed: [
          {
            name: "database-liveness",
            required: true,
            reason: "connection refused",
            durationMs: 5,
          },
        ],
      })),
      strategies: { cold: hotStrategy(async () => makeRuntime("rt-next")) },
    });

    await manager.start({ intent: restartIntent });
    await settle();

    const stored = repo.ops[0];
    expect(stored.status).toBe("failed");
    expect(stored.error).toEqual({
      message: "Required health checks failed",
      code: "health-check-failed",
    });
    expect(stored.phases.map((p) => [p.name, p.status])).toEqual([
      ["validate", "succeeded"],
      ["health-check", "failed"],
    ]);
    expect(stored.phases[1].detail).toEqual({
      passed: [],
      failed: [
        {
          name: "database-liveness",
          required: true,
          reason: "connection refused",
          durationMs: 5,
        },
      ],
    });
    expect(stored.finishedAt).toBeDefined();
  });
});

describe("DefaultRuntimeOperationManager queries", () => {
  it("delegates get, list and findActive to the repository", async () => {
    const active: RuntimeOperation = {
      id: "55555555-5555-4555-8555-555555555555",
      kind: "restart",
      intent: restartIntent,
      tier: "cold",
      status: "running",
      phases: [],
      startedAt: 1,
    };
    const { manager } = makeHarness({ seed: [active] });

    expect(await manager.get(active.id)).toEqual(active);
    expect(await manager.get("missing")).toBeNull();
    expect(await manager.list()).toEqual([active]);
    expect(await manager.list({ status: "failed" })).toEqual([]);
    expect(await manager.findActive()).toEqual(active);
  });
});
