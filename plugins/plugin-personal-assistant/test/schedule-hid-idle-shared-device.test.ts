/**
 * Replays the cases of quint/HidIdleSharedDevice.qnt through the production
 * path on a PGlite-backed runtime: the macOS activity collector's HID idle
 * sample (ActivityTrackerService writes it as a desktop_interaction signal),
 * a client resume (LifeOpsService.captureActivitySignal, app_lifecycle
 * active) and the schedule inspection (LifeOpsService.inspectSchedule, which
 * scores the signals with computeAwakeProbability).
 *
 * A resume from a client app may come from someone else on a shared device,
 * so its awake evidence counts a quarter unless the owner is interacting at
 * the same time. A HID sample is that evidence only when it shows input in
 * the last minute; a sample that reports hours of idle time is not.
 */

import { readFileSync } from "node:fs";
import { resolveActivitySignalReliability } from "@elizaos/plugin-health/sleep/source-reliability";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { ActivityTrackerService } from "../src/activity-profile/activity-tracker-service.js";
import { LifeOpsRepository } from "../src/lifeops/repository.js";
import { LifeOpsService } from "../src/lifeops/service.js";

/** A HID idle sample as the native collector reports it. */
interface IdleSample {
  ts: number;
  event: "hid_idle";
  idleSeconds: number;
}

// The native HID collector only runs on macOS. This stands in for the
// collector process: it keeps the sample callback of every started collector
// so the test can hand samples to the real tracker service.
const collector = vi.hoisted(() => ({
  handlers: [] as Array<(sample: IdleSample) => void>,
}));
vi.mock("@elizaos/native-activity-tracker", () => ({
  isSupportedPlatform: () => true,
  startActivityCollector: (opts: {
    onIdleSample: (sample: IdleSample) => void;
  }) => {
    collector.handlers.push(opts.onIdleSample);
    return { stop: () => undefined };
  },
}));

/** One model case: the HID sample before the resume, if any. */
interface ModelCase {
  hasSample: boolean;
  /** HID idle seconds the sample reports. */
  idle: number;
  /** Seconds between the sample and the inspection. */
  age: number;
  /** The resume keeps the shared-device discount. */
  discounted: boolean;
}

// 03:00 in America/Los_Angeles; the client resumes 10 seconds earlier.
const NOW_MS = Date.parse("2026-11-16T11:00:00.000Z");
const RESUME_AGE_SECONDS = 10;
const IDLES = [5, 60, 61, 1500, 10800] as const;

// Without the generated cases, the samples develop got wrong (the idle ones
// inside the five-minute window) and their controls.
const DEFAULT_CASES: ModelCase[] = [
  { hasSample: true, idle: 10800, age: 20, discounted: true },
  { hasSample: true, idle: 1500, age: 300, discounted: true },
  { hasSample: true, idle: 61, age: 20, discounted: true },
  { hasSample: true, idle: 5, age: 20, discounted: false },
  { hasSample: false, idle: 0, age: 0, discounted: true },
];

const casesFile = process.env.ELIZA_HID_IDLE_SHARED_DEVICE_MODEL_CASES;
const cases: ModelCase[] = casesFile
  ? JSON.parse(readFileSync(casesFile, "utf8"))
  : DEFAULT_CASES;

const previousDisable = process.env.ELIZA_DISABLE_ACTIVITY_TRACKER;
beforeAll(() => {
  delete process.env.ELIZA_DISABLE_ACTIVITY_TRACKER;
});
afterAll(() => {
  if (previousDisable === undefined) {
    delete process.env.ELIZA_DISABLE_ACTIVITY_TRACKER;
  } else {
    process.env.ELIZA_DISABLE_ACTIVITY_TRACKER = previousDisable;
  }
});

/**
 * Replays one case on a fresh agent and returns the log-likelihood ratio the
 * inspection gives the resume.
 */
async function replayCase(name: string, item: ModelCase): Promise<number> {
  const testRuntime = await createRealTestRuntime({ characterName: name });
  try {
    await LifeOpsRepository.bootstrapSchema(testRuntime.runtime);
    if (item.hasSample) {
      const started = collector.handlers.length;
      const tracker = await ActivityTrackerService.start(testRuntime.runtime);
      expect(tracker.getMode()).not.toBe("disabled-config");
      expect(collector.handlers).toHaveLength(started + 1);
      collector.handlers[started]?.({
        ts: NOW_MS - item.age * 1000,
        event: "hid_idle",
        idleSeconds: item.idle,
      });
      // stop() waits for the queued write.
      await tracker.stop();
    }
    const service = new LifeOpsService(testRuntime.runtime);
    await service.captureActivitySignal({
      source: "app_lifecycle",
      platform: "mobile_app",
      state: "active",
      observedAt: new Date(NOW_MS - RESUME_AGE_SECONDS * 1000).toISOString(),
      idleState: null,
      idleTimeSeconds: null,
      onBattery: null,
      health: null,
      metadata: { reason: "resume" },
    });
    const inspection = await service.inspectSchedule({
      timezone: "America/Los_Angeles",
      now: new Date(NOW_MS),
    });
    const resume = inspection.insight.awakeProbability.contributingSources.find(
      (entry) => entry.source === "app_lifecycle",
    );
    expect(resume).toBeDefined();
    return resume?.logLikelihoodRatio ?? Number.NaN;
  } finally {
    await testRuntime.cleanup();
  }
}

/** The resume's weight with and without the shared-device discount. */
function expectedRatio(discounted: boolean): number {
  const reliability = Math.min(
    1,
    Math.max(
      0,
      resolveActivitySignalReliability("app_lifecycle", "mobile_app", {}),
    ),
  );
  return 2.4 * reliability * (discounted ? 0.25 : 1);
}

it("an idle HID sample keeps the shared-device discount", async () => {
  // Three hours idle, sampled 20 seconds ago: nobody is at the Mac.
  const idle = await replayCase("lifeops-hid-idle-shared-device", {
    hasSample: true,
    idle: 10800,
    age: 20,
    discounted: true,
  });
  expect(idle).toBeCloseTo(expectedRatio(true), 6);
  // Input 5 seconds before the sample: the owner is at the Mac.
  const active = await replayCase("lifeops-hid-active-shared-device", {
    hasSample: true,
    idle: 5,
    age: 20,
    discounted: false,
  });
  expect(active).toBeCloseTo(expectedRatio(false), 6);
}, 120_000);

it.each([
  { name: "no HID sample", group: cases.filter((item) => !item.hasSample) },
  ...IDLES.map((idle) => ({
    name: `HID idle ${idle}s`,
    group: cases.filter((item) => item.hasSample && item.idle === idle),
  })),
])(
  "HID idle model replays $name",
  async ({ name, group }) => {
    // Without generated cases only the samples listed above run.
    if (!casesFile && group.length === 0) return;
    expect(group.length).toBeGreaterThan(0);
    for (const [index, item] of group.entries()) {
      const ratio = await replayCase(`lifeops-hid-idle-${name}-${index}`, item);
      expect({ age: item.age, ratio }).toEqual({
        age: item.age,
        ratio: expect.closeTo(expectedRatio(item.discounted), 6),
      });
    }
  },
  600_000,
);
