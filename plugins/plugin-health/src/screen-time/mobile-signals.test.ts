import { describe, expect, it } from "vitest";
import {
  androidUsageRowsFromSignals,
  iosCoarseUsageRowsFromSignals,
} from "./mobile-signals.js";
import {
  computeScreenTimeRange,
  enumerateScreenTimeHistoryDays,
} from "./ranges.js";

// Android and iOS only report rolling snapshots, so the readers refuse windows
// longer than one civil day. A DST fall-back day is still one civil day: in
// America/Los_Angeles, Sunday 2026-11-01 runs 25 hours (07:00Z to 08:00Z).
const TIME_ZONE = "America/Los_Angeles";

const androidSignal = {
  metadata: {
    screenTime: {
      granted: true,
      topApps: [
        {
          packageName: "com.google.android.youtube",
          totalTimeForegroundMs: 600_000,
        },
      ],
    },
  },
};

const iosSignal = {
  metadata: {
    screenTime: {
      coarseSummaryAvailable: true,
      authorization: { status: "approved" },
      categories: [{ identifier: "social", totalSeconds: 900 }],
    },
  },
};

function fallBackDay() {
  const day = enumerateScreenTimeHistoryDays(
    { since: "2026-10-31T07:00:00.000Z", until: "2026-11-02T20:00:00.000Z" },
    TIME_ZONE,
  ).find((entry) => entry.date === "2026-11-01");
  if (!day) throw new Error("history has no 2026-11-01 bucket");
  return { sinceMs: Date.parse(day.since), untilMs: Date.parse(day.until) };
}

describe("mobile screen-time rows on a DST fall-back day", () => {
  it("keeps Android rows for the 25-hour history day", () => {
    const { sinceMs, untilMs } = fallBackDay();
    expect(untilMs - sinceMs).toBe(25 * 60 * 60_000);

    expect(
      androidUsageRowsFromSignals([androidSignal], sinceMs, untilMs),
    ).toEqual([
      expect.objectContaining({
        identifier: "com.google.android.youtube",
        totalSeconds: 600,
      }),
    ]);
  });

  it("keeps iOS coarse rows for the 25-hour history day", () => {
    const { sinceMs, untilMs } = fallBackDay();

    expect(
      iosCoarseUsageRowsFromSignals([iosSignal], sinceMs, untilMs),
    ).toHaveLength(1);
  });

  it("keeps Android rows for today late on the fall-back day", () => {
    // 23:30 PST on 2026-11-01: "today" began 24.5 hours earlier.
    const today = computeScreenTimeRange(
      "today",
      new Date("2026-11-02T07:30:00.000Z"),
      TIME_ZONE,
    );

    expect(
      androidUsageRowsFromSignals(
        [androidSignal],
        Date.parse(today.since),
        Date.parse(today.until),
      ),
    ).toHaveLength(1);
  });

  it("still refuses a window of two civil days", () => {
    const sinceMs = Date.parse("2026-11-01T07:00:00.000Z");
    const untilMs = Date.parse("2026-11-03T08:00:00.000Z");

    expect(
      androidUsageRowsFromSignals([androidSignal], sinceMs, untilMs),
    ).toEqual([]);
    expect(
      iosCoarseUsageRowsFromSignals([iosSignal], sinceMs, untilMs),
    ).toEqual([]);
  });
});
