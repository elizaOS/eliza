/**
 * Regression coverage for the telemetry-mirror failure boundary inside
 * `LifeOpsRepository.createActivitySignal` (#15820): a failing mirror write
 * must never reject the already-committed signal insert, but it must surface
 * through `runtime.reportError` as a typed ElizaError with the original cause,
 * throttled to the first and every 100th consecutive failure. Deterministic:
 * drives the real repository, registry, and telemetry mapper against a fake
 * runtime DB that fails only the `life_telemetry_events` insert.
 */

import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type { LifeOpsActivitySignal } from "@elizaos/shared";
import { describe, expect, it, vi } from "vitest";
import {
  createSignalSourceRegistry,
  registerSignalSourceRegistry,
} from "./registries/signal-source-registry.js";
import { LifeOpsRepository } from "./repository.js";
import type { RawSqlQuery } from "./sql.js";
import { registerBuiltinSignalSources } from "./telemetry-mapping.js";

function rawSqlTextOf(query: RawSqlQuery): string {
  return query.queryChunks
    .map((chunk) =>
      Array.isArray(chunk.value)
        ? chunk.value.join("")
        : typeof chunk.value === "string"
          ? chunk.value
          : "",
    )
    .join("");
}

interface MirrorHarness {
  runtime: IAgentRuntime;
  repository: LifeOpsRepository;
  reportError: ReturnType<typeof vi.fn>;
  mirrorError: Error;
  setTelemetryDown: (down: boolean) => void;
  executedSignalInserts: () => number;
}

/**
 * Real `LifeOpsRepository` over a fake runtime DB: signal inserts always
 * succeed; telemetry inserts throw while `telemetryDown` is set. The signal
 * source registry is the real built-in registration, so the mirror path runs
 * the production mapper before hitting the failing write.
 */
function createMirrorHarness(): MirrorHarness {
  let telemetryDown = false;
  let signalInserts = 0;
  const mirrorError = new Error("telemetry store offline");
  const reportError = vi.fn();
  const runtime = {
    adapter: {
      db: {
        execute: async (query: RawSqlQuery) => {
          const sqlText = rawSqlTextOf(query);
          if (sqlText.includes("app_lifeops.life_telemetry_events")) {
            if (telemetryDown) throw mirrorError;
            return { rows: [{ id: "telemetry-row" }] };
          }
          if (sqlText.includes("app_lifeops.life_activity_signals")) {
            signalInserts += 1;
          }
          return { rows: [] };
        },
      },
    },
    reportError,
  } as unknown as IAgentRuntime;

  const registry = createSignalSourceRegistry();
  registerBuiltinSignalSources(registry);
  registerSignalSourceRegistry(runtime, registry);

  return {
    runtime,
    repository: new LifeOpsRepository(runtime),
    reportError,
    mirrorError,
    setTelemetryDown: (down: boolean) => {
      telemetryDown = down;
    },
    executedSignalInserts: () => signalInserts,
  };
}

// Unique agent per test: the mirror-failure counter is a per-agent static on
// LifeOpsRepository and would otherwise leak counts across cases.
function signal(
  agentId: string,
  overrides: Partial<LifeOpsActivitySignal> = {},
): LifeOpsActivitySignal {
  return {
    id: crypto.randomUUID(),
    agentId,
    source: "desktop_interaction",
    platform: "macos_desktop",
    state: "active",
    observedAt: "2026-07-06T04:00:00.000Z",
    idleState: null,
    idleTimeSeconds: 3,
    onBattery: null,
    health: null,
    metadata: {},
    createdAt: "2026-07-06T04:00:00.000Z",
    ...overrides,
  };
}

describe("LifeOpsRepository.createActivitySignal telemetry mirror", () => {
  it("commits the signal row and reports a typed failure when the mirror write fails", async () => {
    const harness = createMirrorHarness();
    const agentId = crypto.randomUUID();
    harness.setTelemetryDown(true);

    await expect(
      harness.repository.createActivitySignal(signal(agentId)),
    ).resolves.toBeUndefined();

    expect(harness.executedSignalInserts()).toBe(1);
    expect(harness.reportError).toHaveBeenCalledTimes(1);
    const [scope, error] = harness.reportError.mock.calls[0] as [
      string,
      unknown,
    ];
    expect(scope).toBe("lifeops.repository");
    expect(error).toBeInstanceOf(ElizaError);
    const typed = error as ElizaError;
    expect(typed.code).toBe("LIFEOPS_ACTIVITY_TELEMETRY_MIRROR_FAILED");
    expect(typed.cause).toBe(harness.mirrorError);
    expect(typed.context).toEqual({
      agentId,
      source: "desktop_interaction",
      platform: "macos_desktop",
      consecutiveFailures: 1,
    });
  });

  it("does not report when the mirror write succeeds", async () => {
    const harness = createMirrorHarness();
    const agentId = crypto.randomUUID();

    await harness.repository.createActivitySignal(signal(agentId));

    expect(harness.executedSignalInserts()).toBe(1);
    expect(harness.reportError).not.toHaveBeenCalled();
  });

  it("throttles reporting to the first and every 100th consecutive failure", async () => {
    const harness = createMirrorHarness();
    const agentId = crypto.randomUUID();
    harness.setTelemetryDown(true);

    for (let i = 0; i < 100; i++) {
      await harness.repository.createActivitySignal(signal(agentId));
    }

    // Every signal row still committed despite the broken mirror.
    expect(harness.executedSignalInserts()).toBe(100);
    expect(harness.reportError).toHaveBeenCalledTimes(2);
    const second = harness.reportError.mock.calls[1]?.[1] as ElizaError;
    expect(second.context).toMatchObject({ consecutiveFailures: 100 });
  });

  it("resets the failure counter after a successful mirror so the next failure reports again", async () => {
    const harness = createMirrorHarness();
    const agentId = crypto.randomUUID();

    harness.setTelemetryDown(true);
    await harness.repository.createActivitySignal(signal(agentId));
    harness.setTelemetryDown(false);
    await harness.repository.createActivitySignal(signal(agentId));
    harness.setTelemetryDown(true);
    await harness.repository.createActivitySignal(signal(agentId));

    expect(harness.reportError).toHaveBeenCalledTimes(2);
    const calls = harness.reportError.mock.calls.map(
      (call) => (call[1] as ElizaError).context,
    );
    expect(calls[0]).toMatchObject({ consecutiveFailures: 1 });
    expect(calls[1]).toMatchObject({ consecutiveFailures: 1 });
  });
});
