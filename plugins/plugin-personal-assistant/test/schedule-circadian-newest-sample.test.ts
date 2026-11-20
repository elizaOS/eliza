/**
 * Replays the cases of quint/CircadianNewestSample.qnt through the production
 * path on a PGlite-backed runtime: the macOS activity collector's HID idle
 * samples (ActivityTrackerService writes each as a desktop_interaction
 * signal), the paired-iPhone continuity probe (probeContinuityDevices writes
 * each connection change as a mobile_device signal) and the schedule
 * inspection (LifeOpsService.inspectSchedule, which scores the signals with
 * scoreCircadianRules).
 *
 * hid.idleGt20m and continuity.iphoneDisconnected describe the current state
 * of their source, so they read the newest report of that source: an older
 * idle sample or disconnect no longer counts once a newer report shows the
 * owner at the keyboard or the iPhone back.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createRealTestRuntime } from "../../../packages/app/test/helpers/real-runtime.ts";
import { ActivityTrackerService } from "../src/activity-profile/activity-tracker-service.js";
import {
  type ContinuityShellRunner,
  probeContinuityDevices,
} from "../src/lifeops/continuity-probe.js";
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

// Model encoding: a HID report is its idle seconds (-1 = none); an iPhone
// report is 0 (none), 1 (connected) or 2 (disconnected).
const NO_SAMPLE = -1;
const ABSENT = 0;
const CONNECTED = 1;
const DISCONNECTED = 2;

/** One model case: an older and a newer report of one source. */
interface ModelCase {
  hid: boolean;
  older: number;
  newer: number;
  /** The source's rule fires at the inspection. */
  fired: boolean;
}

// 23:45 in America/Los_Angeles, inside the overnight window of both rules.
const NOW_MS = Date.parse("2026-11-17T07:45:00.000Z");
const TIMEZONE = "America/Los_Angeles";
// Report ages at the inspection, in seconds.
const HID_AGES = { older: 600, newer: 30 } as const;
const PHONE_AGES = { older: 2400, newer: 900 } as const;
const HID_REPORTS = [NO_SAMPLE, 5, 1199, 1200] as const;
const PHONE_REPORTS = [ABSENT, CONNECTED, DISCONNECTED] as const;

// Without the generated cases, the reports develop got wrong (a newer report
// that contradicts the older one) and their controls.
const DEFAULT_CASES: ModelCase[] = [
  { hid: true, older: 1200, newer: 5, fired: false },
  { hid: true, older: 1200, newer: NO_SAMPLE, fired: true },
  { hid: true, older: 5, newer: 1200, fired: true },
  { hid: false, older: DISCONNECTED, newer: CONNECTED, fired: false },
  { hid: false, older: DISCONNECTED, newer: ABSENT, fired: true },
  { hid: false, older: CONNECTED, newer: DISCONNECTED, fired: true },
];

const casesFile = process.env.ELIZA_CIRCADIAN_NEWEST_SAMPLE_MODEL_CASES;
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

/** `xcrun devicectl` output for one paired iPhone; Bluetooth reports none. */
function devicectl(connected: boolean): ContinuityShellRunner {
  return {
    async run(command) {
      if (command !== "xcrun") throw new Error(`${command} is not available`);
      return {
        stdout: JSON.stringify({
          result: {
            devices: [
              {
                identifier: "00008110-0001A2B33C44801E",
                deviceProperties: {
                  name: "Owner iPhone",
                  deviceType: "iPhone",
                },
                connectionProperties: {
                  pairingState: "paired",
                  tunnelState: connected ? "connected" : "disconnected",
                },
              },
            ],
          },
        }),
      };
    },
  };
}

/** Runs the continuity probe as on a Mac at `atMs`. */
async function probeIPhone(
  runtime: Awaited<ReturnType<typeof createRealTestRuntime>>["runtime"],
  atMs: number,
  connected: boolean,
): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  try {
    await probeContinuityDevices({
      repository: new LifeOpsRepository(runtime),
      agentId: String(runtime.agentId),
      now: new Date(atMs),
      shell: devicectl(connected),
    });
  } finally {
    if (platform) Object.defineProperty(process, "platform", platform);
  }
}

/** The rule of the case's source and the time of its newest report. */
function expected(item: ModelCase): {
  name: string;
  observedAt: string | null;
} {
  const ages = item.hid ? HID_AGES : PHONE_AGES;
  const none = item.hid ? NO_SAMPLE : ABSENT;
  const age = item.newer !== none ? ages.newer : ages.older;
  return {
    name: item.hid ? "hid.idleGt20m" : "continuity.iphoneDisconnected",
    observedAt: item.fired ? new Date(NOW_MS - age * 1000).toISOString() : null,
  };
}

/**
 * Replays one case on a fresh agent and returns when the source's rule
 * fired at the inspection (null when it did not).
 */
async function replayCase(
  name: string,
  item: ModelCase,
): Promise<string | null> {
  const testRuntime = await createRealTestRuntime({ characterName: name });
  try {
    await LifeOpsRepository.bootstrapSchema(testRuntime.runtime);
    const ages = item.hid ? HID_AGES : PHONE_AGES;
    const reports = (
      [
        [ages.older, item.older],
        [ages.newer, item.newer],
      ] as const
    ).filter(([, report]) => report !== (item.hid ? NO_SAMPLE : ABSENT));
    if (item.hid && reports.length > 0) {
      const started = collector.handlers.length;
      const tracker = await ActivityTrackerService.start(testRuntime.runtime);
      expect(tracker.getMode()).not.toBe("disabled-config");
      expect(collector.handlers).toHaveLength(started + 1);
      for (const [age, idleSeconds] of reports) {
        collector.handlers[started]?.({
          ts: NOW_MS - age * 1000,
          event: "hid_idle",
          idleSeconds,
        });
      }
      // stop() waits for the queued writes.
      await tracker.stop();
    }
    if (!item.hid) {
      for (const [age, report] of reports) {
        await probeIPhone(
          testRuntime.runtime,
          NOW_MS - age * 1000,
          report === CONNECTED,
        );
      }
    }
    const inspection = await new LifeOpsService(
      testRuntime.runtime,
    ).inspectSchedule({ timezone: TIMEZONE, now: new Date(NOW_MS) });
    const firing = inspection.insight.circadianRuleFirings.find(
      (entry) => entry.name === expected(item).name,
    );
    return firing?.observedAt ?? null;
  } finally {
    await testRuntime.cleanup();
  }
}

it("a newer report ends an idle or disconnect rule", async () => {
  // Idle 20 minutes ten minutes ago, typing 30 seconds ago.
  const back = { hid: true, older: 1200, newer: 5, fired: false };
  expect(await replayCase("lifeops-circadian-hid-back", back)).toBeNull();
  // The iPhone disconnected 40 minutes ago and reconnected 15 minutes ago.
  const reconnected = {
    hid: false,
    older: DISCONNECTED,
    newer: CONNECTED,
    fired: false,
  };
  expect(
    await replayCase("lifeops-circadian-phone-back", reconnected),
  ).toBeNull();
  // Controls: the newest report still shows idle or disconnected.
  const idle = { hid: true, older: 5, newer: 1200, fired: true };
  expect(await replayCase("lifeops-circadian-hid-idle", idle)).toBe(
    expected(idle).observedAt,
  );
  const away = {
    hid: false,
    older: CONNECTED,
    newer: DISCONNECTED,
    fired: true,
  };
  expect(await replayCase("lifeops-circadian-phone-away", away)).toBe(
    expected(away).observedAt,
  );
}, 120_000);

const HID_NAMES: Record<number, string> = {
  [NO_SAMPLE]: "none",
  5: "5s",
  1199: "1199s",
  1200: "1200s",
};
const PHONE_NAMES: Record<number, string> = {
  [ABSENT]: "none",
  [CONNECTED]: "connected",
  [DISCONNECTED]: "disconnected",
};

it.each([
  ...HID_REPORTS.map((older) => ({
    name: `HID older ${HID_NAMES[older]}`,
    group: cases.filter((item) => item.hid && item.older === older),
  })),
  ...PHONE_REPORTS.map((older) => ({
    name: `iPhone older ${PHONE_NAMES[older]}`,
    group: cases.filter((item) => !item.hid && item.older === older),
  })),
])(
  "circadian model replays $name",
  async ({ name, group }) => {
    // Without generated cases only the reports listed above run.
    if (!casesFile && group.length === 0) return;
    expect(group.length).toBeGreaterThan(0);
    for (const [index, item] of group.entries()) {
      const observedAt = await replayCase(
        `lifeops-circadian-${name}-${index}`,
        item,
      );
      expect({ newer: item.newer, observedAt }).toEqual({
        newer: item.newer,
        observedAt: expected(item).observedAt,
      });
    }
  },
  600_000,
);
