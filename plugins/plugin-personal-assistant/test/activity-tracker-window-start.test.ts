/**
 * Activity tracker reports on a real PGlite runtime: an app that is already in
 * front when a report window opens counts from the window start, and the
 * tracker closes the app in front when its collector stops, so that carried
 * interval never spans time the collector did not observe.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/app/test/helpers/real-runtime.ts";
import {
  insertActivityEvent,
  listActivityEvents,
} from "../src/activity-profile/activity-tracker-repo.ts";
import {
  getActivityReportBetween,
  getTimeOnApp,
} from "../src/activity-profile/activity-tracker-reporting.ts";
import { ActivityTrackerService } from "../src/activity-profile/activity-tracker-service.ts";
import { LifeOpsRepository } from "../src/lifeops/repository.ts";
import { LifeOpsService } from "../src/lifeops/service.ts";

const HOUR_MS = 60 * 60_000;

type CollectorOptions = {
  onEvent: (event: {
    ts: number;
    event: "activate" | "deactivate";
    bundleId: string;
    appName: string;
  }) => void;
  onExit: (exit: { reason?: string }) => void;
  onFatal: (reason: string) => void;
};

// The Swift collector only runs on macOS; stand in for the spawned helper and
// keep the callbacks the service hands it.
const collector = vi.hoisted(() => ({
  options: null as CollectorOptions | null,
}));

vi.mock("@elizaos/native-activity-tracker", () => ({
  isSupportedPlatform: () => true,
  startActivityCollector: (options: CollectorOptions) => {
    collector.options = options;
    return { pid: 4242, stop: async () => {} };
  },
}));

let runtimeResult: RealTestRuntimeResult | null = null;

beforeEach(async () => {
  runtimeResult = await createRealTestRuntime();
  await LifeOpsRepository.bootstrapSchema(runtimeResult.runtime);
  collector.options = null;
});

afterEach(async () => {
  await runtimeResult?.cleanup();
  runtimeResult = null;
});

function requireRuntime(): IAgentRuntime {
  const runtime = runtimeResult?.runtime;
  if (!runtime) throw new Error("runtime not started");
  return runtime;
}

function requireCollector(): CollectorOptions {
  if (!collector.options) throw new Error("collector not started");
  return collector.options;
}

async function insertEvent(
  runtime: IAgentRuntime,
  observedAtMs: number,
  eventKind: "activate" | "deactivate",
  bundleId: string,
  appName: string,
): Promise<void> {
  await insertActivityEvent(runtime, {
    agentId: String(runtime.agentId),
    observedAt: new Date(observedAtMs).toISOString(),
    eventKind,
    bundleId,
    appName,
    windowTitle: null,
  });
}

describe("activity report window start", () => {
  it("counts the app already in front from the window start", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const nowMs = Date.now();
    // Xcode came to the front two hours ago and the owner has not switched.
    await insertEvent(
      runtime,
      nowMs - 2 * HOUR_MS,
      "activate",
      "com.apple.dt.Xcode",
      "Xcode",
    );

    const report = await getActivityReportBetween(runtime, agentId, {
      sinceMs: nowMs - HOUR_MS,
      untilMs: nowMs,
    });
    expect(report.apps).toEqual([
      expect.objectContaining({
        bundleId: "com.apple.dt.Xcode",
        totalMs: HOUR_MS,
        sessionCount: 1,
      }),
    ]);
    expect(report.totalMs).toBe(HOUR_MS);

    // OWNER_SCREENTIME time_on_app reads the same report.
    const timeOnApp = await getTimeOnApp(runtime, agentId, "Xcode", {
      windowMs: HOUR_MS,
      nowMs,
    });
    expect(timeOnApp).toEqual({ totalMs: HOUR_MS, matchedBy: "appName" });

    // The screen-time summary route reads it through LifeOpsService.
    const summary = await new LifeOpsService(runtime).getScreenTimeSummary({
      since: new Date(nowMs - HOUR_MS).toISOString(),
      until: new Date(nowMs).toISOString(),
      source: "app",
      topN: 5,
    });
    expect(summary.items).toEqual([
      expect.objectContaining({
        identifier: "com.apple.dt.Xcode",
        totalSeconds: 3600,
      }),
    ]);
  });

  it("ends the carried interval at the next event inside the window", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const windowStartMs = Date.parse("2025-03-10T09:00:00.000Z");
    await insertEvent(
      runtime,
      windowStartMs - 30 * 60_000,
      "activate",
      "com.tinyspeck.slackmacgap",
      "Slack",
    );
    await insertEvent(
      runtime,
      windowStartMs + 15 * 60_000,
      "activate",
      "com.apple.Safari",
      "Safari",
    );

    const report = await getActivityReportBetween(runtime, agentId, {
      sinceMs: windowStartMs,
      untilMs: windowStartMs + HOUR_MS,
    });
    expect(
      report.apps.map((app) => [app.bundleId, app.totalMs / 60_000]),
    ).toEqual([
      ["com.apple.Safari", 45],
      ["com.tinyspeck.slackmacgap", 15],
    ]);
  });

  it("carries nothing when the last app was closed before the window", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const windowStartMs = Date.parse("2025-03-11T09:00:00.000Z");
    await insertEvent(
      runtime,
      windowStartMs - 2 * HOUR_MS,
      "activate",
      "com.apple.Notes",
      "Notes",
    );
    await insertEvent(
      runtime,
      windowStartMs - HOUR_MS,
      "deactivate",
      "com.apple.Notes",
      "Notes",
    );

    const report = await getActivityReportBetween(runtime, agentId, {
      sinceMs: windowStartMs,
      untilMs: windowStartMs + HOUR_MS,
    });
    expect(report.apps).toEqual([]);
    expect(report.totalMs).toBe(0);
  });

  it("looks past an event without a bundle id for the app in front", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const windowStartMs = Date.parse("2025-03-12T09:00:00.000Z");
    await insertEvent(
      runtime,
      windowStartMs - 30 * 60_000,
      "activate",
      "com.apple.dt.Xcode",
      "Xcode",
    );
    // The collector writes "" for an app without a bundle id (a CLI helper).
    // Reports drop such rows, so Xcode stays the app in front.
    await insertEvent(
      runtime,
      windowStartMs - 10 * 60_000,
      "activate",
      "",
      "python3",
    );

    const report = await getActivityReportBetween(runtime, agentId, {
      sinceMs: windowStartMs,
      untilMs: windowStartMs + HOUR_MS,
    });
    expect(
      report.apps.map((app) => [app.bundleId, app.totalMs / 60_000]),
    ).toEqual([["com.apple.dt.Xcode", 60]]);

    // A window that holds both events counts Xcode across the unbundled one.
    const wider = await getActivityReportBetween(runtime, agentId, {
      sinceMs: windowStartMs - 30 * 60_000,
      untilMs: windowStartMs + HOUR_MS,
    });
    expect(
      wider.apps.map((app) => [app.bundleId, app.totalMs / 60_000]),
    ).toEqual([["com.apple.dt.Xcode", 90]]);
  });

  it("carries the app activated in the same millisecond another one closed", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const windowStartMs = Date.parse("2025-03-13T09:00:00.000Z");
    const switchedAtMs = windowStartMs - 10 * 60_000;
    await insertEvent(
      runtime,
      windowStartMs - 30 * 60_000,
      "activate",
      "com.apple.Safari",
      "Safari",
    );
    // An app switch: Safari's deactivate and Notes' activate share a stamp.
    await insertEvent(
      runtime,
      switchedAtMs,
      "deactivate",
      "com.apple.Safari",
      "Safari",
    );
    await insertEvent(
      runtime,
      switchedAtMs,
      "activate",
      "com.apple.Notes",
      "Notes",
    );

    const report = await getActivityReportBetween(runtime, agentId, {
      sinceMs: windowStartMs,
      untilMs: windowStartMs + HOUR_MS,
    });
    expect(
      report.apps.map((app) => [app.bundleId, app.totalMs / 60_000]),
    ).toEqual([["com.apple.Notes", 60]]);
  });
});

describe("activity tracker collector stop", () => {
  it("closes the app in front when the service stops", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const activatedAtMs = Date.now() - 3 * HOUR_MS;
    const service = await ActivityTrackerService.start(runtime);
    expect(service.getMode()).toBe("running");
    requireCollector().onEvent({
      ts: activatedAtMs,
      event: "activate",
      bundleId: "com.apple.dt.Xcode",
      appName: "Xcode",
    });

    const stopAtMs = Date.now();
    await service.stop();

    const events = await listActivityEvents(
      runtime,
      agentId,
      new Date(activatedAtMs).toISOString(),
    );
    expect(events.map((event) => [event.eventKind, event.bundleId])).toEqual([
      ["activate", "com.apple.dt.Xcode"],
      ["deactivate", "com.apple.dt.Xcode"],
    ]);
    const closedAtMs = Date.parse(events[1]?.observedAt ?? "");
    expect(closedAtMs).toBeGreaterThanOrEqual(stopAtMs);
    expect(closedAtMs).toBeLessThanOrEqual(Date.now());

    // A window that opens while the agent is down shows no Xcode time.
    const report = await getActivityReportBetween(runtime, agentId, {
      sinceMs: Date.now() + HOUR_MS,
      untilMs: Date.now() + 2 * HOUR_MS,
    });
    expect(report.apps).toEqual([]);
  });

  it("closes the app in front when the collector dies", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const activatedAtMs = Date.now() - HOUR_MS;
    const service = await ActivityTrackerService.start(runtime);
    const { onEvent, onFatal } = requireCollector();
    onEvent({
      ts: activatedAtMs,
      event: "activate",
      bundleId: "com.apple.Terminal",
      appName: "Terminal",
    });

    onFatal("collector exited (code=null, signal=SIGKILL)");
    expect(service.getMode()).toBe("failed");
    await service.stop();

    const events = await listActivityEvents(
      runtime,
      agentId,
      new Date(activatedAtMs).toISOString(),
    );
    expect(events.map((event) => [event.eventKind, event.bundleId])).toEqual([
      ["activate", "com.apple.Terminal"],
      ["deactivate", "com.apple.Terminal"],
    ]);
  });

  it("closes the app in front after its activate when both share a millisecond", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const activatedAtMs = Date.now() - HOUR_MS;
    const service = await ActivityTrackerService.start(runtime);
    requireCollector().onEvent({
      ts: activatedAtMs,
      event: "activate",
      bundleId: "com.apple.dt.Xcode",
      appName: "Xcode",
    });

    // The service stops in the millisecond the collector stamped the activate.
    const clock = vi.spyOn(Date, "now").mockReturnValue(activatedAtMs);
    try {
      await service.stop();
    } finally {
      clock.mockRestore();
    }

    // Neither a later window nor one that spans the stop counts Xcode as open.
    const later = await getActivityReportBetween(runtime, agentId, {
      sinceMs: activatedAtMs + 30 * 60_000,
      untilMs: activatedAtMs + HOUR_MS,
    });
    expect(later.apps).toEqual([]);
    const spanning = await getActivityReportBetween(runtime, agentId, {
      sinceMs: activatedAtMs - 60_000,
      untilMs: activatedAtMs + HOUR_MS,
    });
    expect(spanning.totalMs).toBeLessThanOrEqual(1);

    const events = await listActivityEvents(
      runtime,
      agentId,
      new Date(activatedAtMs).toISOString(),
    );
    expect(events.map((event) => event.eventKind)).toEqual([
      "activate",
      "deactivate",
    ]);
    const closedAtMs = Date.parse(events[1]?.observedAt ?? "");
    expect(closedAtMs).toBeGreaterThan(activatedAtMs);
  });

  it("closes the bundled app in front when an app without a bundle id came after it", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const activatedAtMs = Date.now() - HOUR_MS;
    const service = await ActivityTrackerService.start(runtime);
    const { onEvent } = requireCollector();
    onEvent({
      ts: activatedAtMs,
      event: "activate",
      bundleId: "com.apple.dt.Xcode",
      appName: "Xcode",
    });
    onEvent({
      ts: activatedAtMs + 10 * 60_000,
      event: "activate",
      bundleId: "",
      appName: "python3",
    });

    await service.stop();
    const stoppedAtMs = Date.now();

    // Reports drop the unbundled rows, so the closing event must name Xcode.
    const spanning = await getActivityReportBetween(runtime, agentId, {
      sinceMs: activatedAtMs,
      untilMs: stoppedAtMs + HOUR_MS,
    });
    expect(spanning.apps.map((app) => app.bundleId)).toEqual([
      "com.apple.dt.Xcode",
    ]);
    expect(spanning.totalMs).toBeLessThanOrEqual(stoppedAtMs - activatedAtMs);
    const later = await getActivityReportBetween(runtime, agentId, {
      sinceMs: stoppedAtMs + 30 * 60_000,
      untilMs: stoppedAtMs + HOUR_MS,
    });
    expect(later.apps).toEqual([]);
  });

  it("writes no closing event when no app is in front", async () => {
    const runtime = requireRuntime();
    const agentId = String(runtime.agentId);
    const activatedAtMs = Date.now() - HOUR_MS;
    const service = await ActivityTrackerService.start(runtime);
    const { onEvent } = requireCollector();
    onEvent({
      ts: activatedAtMs,
      event: "activate",
      bundleId: "com.apple.Safari",
      appName: "Safari",
    });
    // Screen lock: the collector closes Safari itself.
    onEvent({
      ts: activatedAtMs + 60_000,
      event: "deactivate",
      bundleId: "com.apple.Safari",
      appName: "Safari",
    });

    await service.stop();

    const events = await listActivityEvents(
      runtime,
      agentId,
      new Date(activatedAtMs).toISOString(),
    );
    expect(events.map((event) => event.eventKind)).toEqual([
      "activate",
      "deactivate",
    ]);
  });
});
