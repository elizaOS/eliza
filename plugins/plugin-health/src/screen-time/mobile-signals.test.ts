import { describe, expect, it } from "vitest";
import {
  androidUsageRowsFromSignals,
  mobileScreenTimeDataSourceFromSignals,
  type ScreenTimeMobileSignal,
} from "./mobile-signals.js";

describe("screen-time mobile signals", () => {
  it("converts Android Usage Stats snapshots into aggregate app rows", () => {
    const sinceMs = Date.parse("2026-06-02T00:00:00.000Z");
    const untilMs = Date.parse("2026-06-02T23:59:00.000Z");

    expect(
      androidUsageRowsFromSignals(
        [
          {
            metadata: {
              screenTime: {
                granted: true,
                topApps: [
                  {
                    packageName: "com.google.android.youtube",
                    totalTimeForegroundMs: 120_500,
                    lastTimeUsed: 1_780_000_000_000,
                  },
                  {
                    packageName: "com.discord",
                    totalTimeForegroundMs: 90_000,
                  },
                ],
              },
            },
          },
          {
            metadata: {
              screenTime: {
                granted: true,
                topApps: [
                  {
                    packageName: "com.google.android.youtube",
                    totalTimeForegroundMs: 60_000,
                  },
                ],
              },
            },
          },
        ],
        sinceMs,
        untilMs,
      ),
    ).toEqual([
      {
        source: "app",
        identifier: "com.google.android.youtube",
        displayName: "YouTube",
        totalSeconds: 120,
        sessionCount: 1,
        metadata: {
          platform: "android",
          packageName: "com.google.android.youtube",
          lastTimeUsed: 1_780_000_000_000,
        },
      },
      {
        source: "app",
        identifier: "com.discord",
        displayName: "Discord",
        totalSeconds: 90,
        sessionCount: 1,
        metadata: {
          platform: "android",
          packageName: "com.discord",
          lastTimeUsed: null,
        },
      },
    ]);
  });

  it("does not use rolling Android snapshots for multi-day windows", () => {
    const sinceMs = Date.parse("2026-06-01T00:00:00.000Z");
    const untilMs = Date.parse("2026-06-03T00:00:00.000Z");

    expect(
      androidUsageRowsFromSignals(
        [
          {
            metadata: {
              screenTime: {
                granted: true,
                topApps: [
                  {
                    packageName: "com.reddit.frontpage",
                    totalTimeForegroundMs: 30_000,
                  },
                ],
              },
            },
          },
        ],
        sinceMs,
        untilMs,
      ),
    ).toEqual([]);
  });

  it("summarizes Android mobile screen-time setup state", () => {
    expect(mobileScreenTimeDataSourceFromSignals([], "android")).toEqual({
      state: "unwired",
      statusLabel: "Not connected",
      detail: "No recent Android Usage Stats signal has been received.",
    });

    expect(
      mobileScreenTimeDataSourceFromSignals(
        [
          {
            platform: "android",
            source: "mobile_device",
            metadata: { screenTime: { granted: true } },
          },
        ],
        "android",
      ),
    ).toEqual({
      state: "partial",
      statusLabel: "Snapshot only",
      detail:
        "Android currently provides rolling Usage Stats snapshots; multi-day totals exclude Android until daily exports are wired.",
    });

    expect(
      mobileScreenTimeDataSourceFromSignals(
        [
          {
            platform: "android",
            source: "mobile_device",
            metadata: { screenTime: { granted: false } },
          },
        ],
        "android",
      ),
    ).toEqual({
      state: "partial",
      statusLabel: "Permission needed",
      detail: "Android Usage Stats permission has not been granted.",
    });
  });

  it("summarizes iOS Screen Time setup state", () => {
    const iosSignal = (
      screenTime: Record<string, unknown>,
    ): ScreenTimeMobileSignal => ({
      platform: "ios",
      source: "mobile_health",
      metadata: { screenTime },
    });

    expect(
      mobileScreenTimeDataSourceFromSignals(
        [iosSignal({ authorization: { status: "approved" } })],
        "ios",
      ),
    ).toEqual({
      state: "partial",
      statusLabel: "Export pending",
      detail:
        "iOS Screen Time authorization is present, but usage export is not wired yet.",
    });

    expect(
      mobileScreenTimeDataSourceFromSignals(
        [iosSignal({ supported: true })],
        "ios",
      ),
    ).toEqual({
      state: "partial",
      statusLabel: "Authorization needed",
      detail: "iOS Screen Time setup has not been approved.",
    });

    expect(
      mobileScreenTimeDataSourceFromSignals(
        [iosSignal({ supported: false })],
        "ios",
      ),
    ).toEqual({
      state: "unwired",
      statusLabel: "Unsupported",
      detail: "This iOS device has not reported Screen Time support.",
    });
  });
});
