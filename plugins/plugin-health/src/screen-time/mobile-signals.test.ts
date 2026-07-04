/**
 * Unit test for Android Usage Stats / iOS Screen Time signal parsing and the
 * mobile data-source status helpers. Deterministic fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  androidUsageRowsFromSignals,
  iosCoarseUsageRowsFromSignals,
  mobileScreenTimeDataSourceFromSignals,
  mobileSignalPermissionTargetForAction,
  mobileSignalSetupActionBadge,
  mobileSignalSetupPrimaryActionLabel,
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
        "Android currently provides rolling Usage Stats snapshots; multi-day totals exclude Android until daily exports are available.",
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
        "iOS Screen Time authorization is present, but usage export is pending.",
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

  it("ingests approved iOS coarse category summaries into aggregate rows", () => {
    const sinceMs = Date.parse("2026-06-02T00:00:00.000Z");
    const untilMs = Date.parse("2026-06-02T23:59:00.000Z");

    expect(
      iosCoarseUsageRowsFromSignals(
        [
          {
            metadata: {
              screenTime: {
                authorization: { status: "approved" },
                coarseSummaryAvailable: true,
                rawUsageExportAvailable: false,
                categories: [
                  {
                    identifier: "social",
                    displayName: "Social",
                    totalMs: 7_200_000,
                  },
                  { identifier: "productivity", totalSeconds: 5_400 },
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
        identifier: "ios.category.social",
        displayName: "Social",
        totalSeconds: 7_200,
        sessionCount: 1,
        metadata: { platform: "ios", kind: "category", categoryId: "social" },
      },
      {
        source: "app",
        identifier: "ios.category.productivity",
        displayName: "productivity",
        totalSeconds: 5_400,
        sessionCount: 1,
        metadata: {
          platform: "ios",
          kind: "category",
          categoryId: "productivity",
        },
      },
    ]);
  });

  it("ignores iOS coarse summaries unless authorization is approved", () => {
    const sinceMs = Date.parse("2026-06-02T00:00:00.000Z");
    const untilMs = Date.parse("2026-06-02T23:59:00.000Z");
    const categories = [{ identifier: "social", totalSeconds: 600 }];

    // Not approved → never ingested.
    for (const status of ["denied", "not-determined", "unavailable"]) {
      expect(
        iosCoarseUsageRowsFromSignals(
          [
            {
              metadata: {
                screenTime: {
                  authorization: { status },
                  coarseSummaryAvailable: true,
                  categories,
                },
              },
            },
          ],
          sinceMs,
          untilMs,
        ),
      ).toEqual([]);
    }

    // Approved but coarse summaries not available → nothing to ingest.
    expect(
      iosCoarseUsageRowsFromSignals(
        [
          {
            metadata: {
              screenTime: {
                authorization: { status: "approved" },
                coarseSummaryAvailable: false,
                categories,
              },
            },
          },
        ],
        sinceMs,
        untilMs,
      ),
    ).toEqual([]);
  });

  it("never ingests raw per-app export even if a signal claims it (platform constraint)", () => {
    const sinceMs = Date.parse("2026-06-02T00:00:00.000Z");
    const untilMs = Date.parse("2026-06-02T23:59:00.000Z");

    expect(
      iosCoarseUsageRowsFromSignals(
        [
          {
            metadata: {
              screenTime: {
                authorization: { status: "approved" },
                coarseSummaryAvailable: true,
                rawUsageExportAvailable: true,
                categories: [{ identifier: "social", totalSeconds: 600 }],
              },
            },
          },
        ],
        sinceMs,
        untilMs,
      ),
    ).toEqual([]);
  });

  it("owns mobile health/screen-time permission setup presentation policy", () => {
    const t = (_key: string, options?: { defaultValue?: string }): string =>
      options?.defaultValue ?? "";

    expect(
      mobileSignalSetupActionBadge(
        {
          id: "health_permissions",
          label: "Health",
          status: "ready",
          canRequest: false,
        },
        t,
      ),
    ).toEqual({ variant: "secondary", label: "Ready" });
    expect(
      mobileSignalSetupActionBadge(
        {
          id: "screen_time_authorization",
          label: "Screen Time",
          status: "needs_action",
          canRequest: true,
        },
        t,
      ),
    ).toEqual({ variant: "outline", label: "Needs action" });
    expect(
      mobileSignalSetupPrimaryActionLabel(
        {
          id: "screen_time_authorization",
          label: "Screen Time",
          status: "needs_action",
          canRequest: true,
        },
        t,
      ),
    ).toBe("Grant");
    expect(
      mobileSignalSetupPrimaryActionLabel(
        {
          id: "screen_time_authorization",
          label: "Screen Time",
          status: "needs_action",
          canRequest: false,
        },
        t,
      ),
    ).toBe("Open Settings");
    expect(
      mobileSignalPermissionTargetForAction({ id: "health_permissions" }),
    ).toBe("health");
    expect(
      mobileSignalPermissionTargetForAction({
        id: "screen_time_authorization",
      }),
    ).toBe("screenTime");
    expect(
      mobileSignalPermissionTargetForAction({ id: "notification_settings" }),
    ).toBe("notifications");
  });
});
