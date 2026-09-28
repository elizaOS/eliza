import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultClassifier } from "./classifier.ts";
import type { HealthChecker } from "./health.ts";
import { DefaultRuntimeOperationManager } from "./manager.ts";
import { FilesystemRuntimeOperationRepository } from "./repository.ts";
import type {
  HealthCheckReport,
  ReloadStrategy,
  ReloadTier,
  RuntimeOperation,
} from "./types.ts";

const runtime = { agentId: "agent-under-test" } as unknown as AgentRuntime;

function strategy(tier: ReloadTier): ReloadStrategy & { calls: number } {
  const s = {
    tier,
    calls: 0,
    async apply() {
      s.calls += 1;
      return runtime;
    },
  };
  return s;
}

function healthChecker(
  runForRuntime: () => Promise<HealthCheckReport>,
): HealthChecker {
  return { runForRuntime } as unknown as HealthChecker;
}

const OK_REPORT: HealthCheckReport = { ok: true, passed: [], failed: [] };

async function waitForTerminal(
  repo: FilesystemRuntimeOperationRepository,
  id: string,
): Promise<RuntimeOperation> {
  let op: RuntimeOperation | null = null;
  await vi.waitFor(async () => {
    op = await repo.get(id);
    expect(op?.status === "pending" || op?.status === "running").toBe(false);
  });
  if (!op) throw new Error(`operation ${id} disappeared`);
  return op;
}

describe("DefaultRuntimeOperationManager", () => {
  let stateDir: string;
  let repository: FilesystemRuntimeOperationRepository;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-ops-"));
    repository = new FilesystemRuntimeOperationRepository(stateDir);
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("upgrades a same-family provider switch to the registered cold strategy when no warm strategy exists", async () => {
    expect(
      defaultClassifier(
        { kind: "provider-switch", provider: "anthropic-subscription" },
        { currentProvider: "anthropic" },
      ),
    ).toBe("warm");

    const cold = strategy("cold");
    const hot = strategy("hot");
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({ currentProvider: "anthropic" }),
      classifier: defaultClassifier,
      healthChecker: healthChecker(async () => OK_REPORT),
      strategies: { cold, hot },
    });

    const outcome = await manager.start({
      intent: { kind: "provider-switch", provider: "anthropic-subscription" },
    });
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind !== "accepted") return;
    expect(outcome.operation.tier).toBe("cold");

    const settled = await waitForTerminal(repository, outcome.operation.id);
    expect(settled.status).toBe("succeeded");
    expect(settled.error).toBeUndefined();
    expect(cold.calls).toBe(1);
    expect(hot.calls).toBe(0);
  });

  it("never substitutes a lighter tier for a heavier one", async () => {
    const hot = strategy("hot");
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({}),
      healthChecker: healthChecker(async () => OK_REPORT),
      strategies: { hot },
    });

    const outcome = await manager.start({
      intent: { kind: "restart", reason: "test" },
    });
    if (outcome.kind !== "accepted") throw new Error(outcome.kind);
    expect(outcome.operation.tier).toBe("cold");

    const settled = await waitForTerminal(repository, outcome.operation.id);
    expect(settled.status).toBe("failed");
    expect(settled.error?.code).toBe("no-strategy-for-tier");
    expect(hot.calls).toBe(0);
  });

  it("marks an op failed when execution throws after it is running, releasing the busy gate", async () => {
    let throwHealth = true;
    const cold = strategy("cold");
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({}),
      healthChecker: healthChecker(async () => {
        if (throwHealth) throw new Error("health checker exploded");
        return OK_REPORT;
      }),
      strategies: { cold },
    });

    const first = await manager.start({
      intent: { kind: "restart", reason: "first" },
    });
    if (first.kind !== "accepted") throw new Error(first.kind);

    const failed = await waitForTerminal(repository, first.operation.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toEqual({
      message: "health checker exploded",
      code: "execution-failed",
    });
    expect(failed.finishedAt).toBeTypeOf("number");
    const lastPhase = failed.phases[failed.phases.length - 1];
    expect(lastPhase?.name).toBe("health-check");
    expect(lastPhase?.status).toBe("failed");
    expect(lastPhase?.finishedAt).toBeTypeOf("number");
    expect(failed.phases.some((phase) => phase.status === "running")).toBe(
      false,
    );
    expect(await manager.findActive()).toBeNull();

    throwHealth = false;
    const second = await manager.start({
      intent: { kind: "restart", reason: "second" },
    });
    expect(second.kind).toBe("accepted");
    if (second.kind !== "accepted") return;
    const succeeded = await waitForTerminal(repository, second.operation.id);
    expect(succeeded.status).toBe("succeeded");
  });
  it("closes a strategy-reported running phase when the strategy throws", async () => {
    const cold: ReloadStrategy = {
      tier: "cold",
      async apply({ reportPhase }) {
        await reportPhase({
          name: "cold-restart",
          status: "running",
          startedAt: Date.now(),
        });
        throw new Error("swap exploded");
      },
    };
    const manager = new DefaultRuntimeOperationManager({
      repository,
      runtime: () => runtime,
      classifyContext: () => ({}),
      healthChecker: healthChecker(async () => OK_REPORT),
      strategies: { cold },
    });

    const outcome = await manager.start({
      intent: { kind: "restart", reason: "strategy-throws" },
    });
    if (outcome.kind !== "accepted") throw new Error(outcome.kind);

    const failed = await waitForTerminal(repository, outcome.operation.id);
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toBe("swap exploded");
    const lastPhase = failed.phases[failed.phases.length - 1];
    expect(lastPhase?.name).toBe("cold-restart");
    expect(lastPhase?.status).toBe("failed");
    expect(lastPhase?.finishedAt).toBeTypeOf("number");
  });
});
