/**
 * Exercises the activity collector's schema boundary and queued writes with a
 * deterministic native transport. It verifies delegation to the shared schema
 * flight while capturing macOS callbacks and repository writes in memory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const schemaAgentIds: string[] = [];
  const activityEvents: Array<{
    runtimeAgentId: string;
    event: Record<string, unknown>;
  }> = [];

  return {
    activitySignals: [] as Array<Record<string, unknown>>,
    activityEvents,
    callbacks: null as null | {
      onEvent: (event: {
        ts: number;
        bundleId?: string;
        appName?: string;
        windowTitle?: string | null;
        event: string;
      }) => void;
      onIdleSample: (sample: { ts: number; idleSeconds: number }) => void;
      onExit: (exit: { reason?: string }) => void;
      onFatal: (reason: string) => void;
    },
    collectorTransitions: [] as Array<"started" | "stopped">,
    ensureLifeOpsSchema: vi.fn(async (runtime: { agentId: string }) => {
      schemaAgentIds.push(runtime.agentId);
    }),
    insertActivityEvent: async (
      runtime: { agentId: string },
      event: Record<string, unknown>,
    ) => {
      activityEvents.push({ runtimeAgentId: runtime.agentId, event });
    },
    schemaAgentIds,
  };
});

vi.mock("@elizaos/native-activity-tracker", () => ({
  isSupportedPlatform: () => true,
  startActivityCollector: (callbacks: NonNullable<typeof mocks.callbacks>) => {
    mocks.callbacks = callbacks;
    mocks.collectorTransitions.push("started");
    return {
      pid: 42,
      stop: async () => {
        mocks.collectorTransitions.push("stopped");
      },
    };
  },
}));

vi.mock("@elizaos/plugin-health", () => ({
  isSystemInactivityApp: (event: { bundleId?: string }) =>
    event.bundleId === "com.apple.loginwindow",
}));

vi.mock("../lifeops/schema-bootstrap.js", () => ({
  ensureLifeOpsSchema: mocks.ensureLifeOpsSchema,
}));

vi.mock("../lifeops/repository.js", () => ({
  createLifeOpsActivitySignal: (signal: Record<string, unknown>) => signal,
  LifeOpsRepository: class LifeOpsRepository {
    async createActivitySignal(signal: Record<string, unknown>): Promise<void> {
      mocks.activitySignals.push(signal);
    }
  },
}));

vi.mock("./activity-tracker-repo.js", () => ({
  insertActivityEvent: mocks.insertActivityEvent,
}));

import { ActivityTrackerService } from "./activity-tracker-service.js";

const runtime = { agentId: "agent-activity" };

describe("ActivityTrackerService", () => {
  beforeEach(() => {
    mocks.activitySignals.length = 0;
    mocks.activityEvents.length = 0;
    mocks.callbacks = null;
    mocks.collectorTransitions.length = 0;
    mocks.schemaAgentIds.length = 0;
    vi.clearAllMocks();
    vi.stubEnv("ELIZA_DISABLE_ACTIVITY_TRACKER", "0");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the shared schema flight and drains native callback writes before stopping", async () => {
    const service = await ActivityTrackerService.start(runtime as never);

    expect(mocks.schemaAgentIds).toEqual(["agent-activity"]);
    expect(mocks.collectorTransitions).toEqual(["started"]);
    expect(service.getMode()).toBe("running");

    mocks.callbacks?.onEvent({
      ts: Date.parse("2026-07-21T12:00:00.000Z"),
      bundleId: "com.apple.loginwindow",
      appName: "loginwindow",
      windowTitle: null,
      event: "activate",
    });
    mocks.callbacks?.onIdleSample({
      ts: Date.parse("2026-07-21T12:01:00.000Z"),
      idleSeconds: 301.4,
    });
    await service.stop();

    expect(mocks.activityEvents).toEqual([
      {
        runtimeAgentId: "agent-activity",
        event: {
          agentId: "agent-activity",
          observedAt: "2026-07-21T12:00:00.000Z",
          eventKind: "deactivate",
          bundleId: "com.apple.loginwindow",
          appName: "loginwindow",
          windowTitle: null,
        },
      },
    ]);
    expect(mocks.activitySignals).toEqual([
      expect.objectContaining({
        source: "desktop_interaction",
        state: "background",
        idleState: "unknown",
        idleTimeSeconds: 301,
      }),
    ]);
    expect(mocks.collectorTransitions).toEqual(["started", "stopped"]);
  });

  it("surfaces a shared schema failure as a failed collector", async () => {
    mocks.ensureLifeOpsSchema.mockRejectedValueOnce(
      new Error("migration unavailable"),
    );

    const service = await ActivityTrackerService.start(runtime as never);

    expect(service.getMode()).toBe("failed");
    expect(mocks.collectorTransitions).toEqual([]);
    expect(mocks.callbacks).toBeNull();
  });
});
