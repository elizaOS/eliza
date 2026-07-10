/**
 * Exercises the activity-signal telemetry mirror against a real repository
 * boundary with a deterministic failing SQL adapter.
 */

import { ElizaError, type IAgentRuntime } from "@elizaos/core";
import type {
  LifeOpsActivitySignal,
  LifeOpsTelemetryPayload,
} from "@elizaos/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetSignalSourceRegistryForTests,
  createSignalSourceRegistry,
  registerSignalSourceRegistry,
} from "./registries/signal-source-registry.js";
import { LifeOpsRepository } from "./repository.js";

function activitySignal(): LifeOpsActivitySignal {
  return {
    id: "signal-telemetry-mirror-failure",
    agentId: "agent-telemetry-mirror-failure",
    source: "desktop_interaction",
    platform: "macos_desktop",
    state: "active",
    observedAt: "2026-07-09T20:00:00.000Z",
    idleState: null,
    idleTimeSeconds: 3,
    onBattery: null,
    health: null,
    metadata: {},
    createdAt: "2026-07-09T20:00:00.000Z",
  };
}

describe("LifeOpsRepository activity telemetry mirror", () => {
  let runtime: IAgentRuntime | undefined;

  afterEach(() => {
    if (runtime) __resetSignalSourceRegistryForTests(runtime);
  });

  it("reports a typed mirror failure after preserving the primary signal insert", async () => {
    const mirrorFailure = new Error("telemetry database unavailable");
    const execute = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(mirrorFailure);
    const reportError = vi.fn();
    runtime = {
      adapter: { db: { execute } },
      reportError,
    } as unknown as IAgentRuntime;
    const registry = createSignalSourceRegistry();
    registry.register({
      source: "desktop_interaction",
      description: "Deterministic repository telemetry fixture.",
      contributor: "test",
      telemetryMapper: (signal): LifeOpsTelemetryPayload => ({
        family: "desktop_idle_sample",
        platform: "macos_desktop",
        idleSeconds: signal.idleTimeSeconds ?? 0,
        source: "iokit_hid",
        isThresholdCrossing: false,
      }),
      reliability: () => 1,
    });
    registerSignalSourceRegistry(runtime, registry);

    await expect(
      new LifeOpsRepository(runtime).createActivitySignal(activitySignal()),
    ).resolves.toBeUndefined();

    expect(execute).toHaveBeenCalledTimes(2);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [scope, reported] = reportError.mock.calls[0] as [string, ElizaError];
    expect(scope).toBe("lifeops.repository.telemetry-mirror");
    expect(reported).toBeInstanceOf(ElizaError);
    expect(reported.code).toBe(
      "LIFEOPS_ACTIVITY_SIGNAL_TELEMETRY_MIRROR_FAILED",
    );
    expect(reported.cause).toBe(mirrorFailure);
    expect(reported.context).toMatchObject({
      agentId: "agent-telemetry-mirror-failure",
      source: "desktop_interaction",
      platform: "macos_desktop",
      consecutiveFailures: 1,
    });
  });
});
