import { describe, expect, it } from "vitest";
import type {
  LifeOpsScreenTimeBreakdown,
  LifeOpsSocialHabitSummary,
} from "../contracts/lifeops.js";
import {
  buildScreenTimeBreakdown,
  buildScreenTimeMetrics,
  buildScreenTimeSummary,
  buildScreenTimeVisibleBuckets,
  buildScreenTimeWeeklyAverageItems,
  type ScreenTimeAggregateRow,
} from "./builders.js";

const rows: ScreenTimeAggregateRow[] = [
  {
    source: "website",
    identifier: "https://youtube.com/watch?v=1",
    displayName: "YouTube",
    totalSeconds: 120,
    sessionCount: 1,
    metadata: { browser: "Safari" },
  },
  {
    source: "website",
    identifier: "https://youtube.com/watch?v=1",
    displayName: "YouTube",
    totalSeconds: 60,
    sessionCount: 2,
    metadata: { browser: "Safari" },
  },
  {
    source: "app",
    identifier: "com.tinyspeck.slackmacgap",
    displayName: "Slack",
    totalSeconds: 240,
    sessionCount: 3,
  },
];

function socialSummary(overrides?: Partial<LifeOpsSocialHabitSummary>) {
  return {
    since: "2026-06-02T00:00:00.000Z",
    until: "2026-06-02T01:00:00.000Z",
    totalSeconds: 420,
    services: [
      { key: "youtube", label: "YouTube", totalSeconds: 180 },
      { key: "x", label: "X", totalSeconds: 30 },
    ],
    devices: [{ key: "computer", label: "Computer", totalSeconds: 240 }],
    surfaces: [{ key: "website", label: "Web", totalSeconds: 180 }],
    browsers: [{ key: "safari", label: "Safari", totalSeconds: 180 }],
    sessions: [],
    messages: {
      channels: [
        {
          channel: "x_dm",
          label: "X DMs",
          inbound: 1,
          outbound: 2,
          opened: 3,
          replied: 1,
        },
      ],
      inbound: 1,
      outbound: 2,
      opened: 3,
      replied: 1,
    },
    dataSources: [
      {
        id: "browser_bridge",
        label: "Browser",
        state: "partial",
        statusLabel: "Needs attention",
        detail: "Permissions incomplete.",
      },
    ],
    fetchedAt: "2026-06-02T01:00:00.000Z",
    ...overrides,
  } satisfies LifeOpsSocialHabitSummary;
}

describe("screen-time builders", () => {
  it("merges aggregate rows and builds ranked summaries", () => {
    expect(buildScreenTimeSummary(rows)).toEqual({
      items: [
        {
          source: "app",
          identifier: "com.tinyspeck.slackmacgap",
          displayName: "Slack",
          totalSeconds: 240,
        },
        {
          source: "website",
          identifier: "https://youtube.com/watch?v=1",
          displayName: "YouTube",
          totalSeconds: 180,
        },
      ],
      totalSeconds: 420,
    });

    expect(
      buildScreenTimeWeeklyAverageItems(buildScreenTimeSummary(rows).items, 7),
    ).toEqual([
      {
        source: "app",
        identifier: "com.tinyspeck.slackmacgap",
        displayName: "Slack",
        totalSeconds: 240,
        averageSecondsPerDay: 34,
        averageMinutesPerDay: 1,
      },
      {
        source: "app",
        identifier: "https://youtube.com/watch?v=1",
        displayName: "YouTube",
        totalSeconds: 180,
        averageSecondsPerDay: 26,
        averageMinutesPerDay: 0,
      },
    ]);
  });

  it("builds categorized breakdown buckets", () => {
    const breakdown = buildScreenTimeBreakdown(
      rows,
      undefined,
      "2026-06-02T01:00:00.000Z",
    );

    expect(breakdown.totalSeconds).toBe(420);
    expect(breakdown.bySource).toEqual([
      { key: "app", label: "Apps", totalSeconds: 240 },
      { key: "website", label: "Web", totalSeconds: 180 },
    ]);
    expect(breakdown.byService).toEqual([
      { key: "slack", label: "Slack", totalSeconds: 240 },
      { key: "youtube", label: "YouTube", totalSeconds: 180 },
    ]);
    expect(breakdown.fetchedAt).toBe("2026-06-02T01:00:00.000Z");
  });

  it("builds metrics and visible buckets", () => {
    const breakdown = buildScreenTimeBreakdown(rows);
    const priorBreakdown: LifeOpsScreenTimeBreakdown = {
      ...breakdown,
      totalSeconds: 210,
      bySource: [{ key: "app", label: "Apps", totalSeconds: 120 }],
      byDevice: [{ key: "computer", label: "Computer", totalSeconds: 120 }],
    };
    const social = socialSummary({
      sessions: breakdown.items,
    });
    const priorSocial = socialSummary({
      totalSeconds: 210,
      services: [{ key: "youtube", label: "YouTube", totalSeconds: 90 }],
      messages: {
        ...social.messages,
        opened: 1,
      },
    });

    expect(
      buildScreenTimeMetrics(breakdown, social, priorBreakdown, priorSocial),
    ).toMatchObject({
      totalSeconds: 420,
      socialSeconds: 420,
      youtubeSeconds: 180,
      xSeconds: 30,
      messageOpened: 3,
      deltas: {
        totalPercent: 100,
        appPercent: 100,
        socialPercent: 100,
        youtubePercent: 100,
        messageOpenedPercent: 200,
      },
    });

    expect(buildScreenTimeVisibleBuckets(breakdown, social)).toMatchObject({
      hasUsage: true,
      hasMessageActivity: true,
      setupSources: [
        {
          id: "browser_bridge",
          state: "partial",
        },
      ],
    });
  });
});
