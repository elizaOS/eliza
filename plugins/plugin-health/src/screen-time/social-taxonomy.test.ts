import { describe, expect, it } from "vitest";
import { buildScreenTimeBreakdown } from "./builders.js";
import { androidUsageRowsFromSignals } from "./mobile-signals.js";
import { classifyScreenTimeTarget } from "./social-taxonomy.js";

const sinceMs = Date.parse("2026-10-25T07:00:00.000Z");
const untilMs = Date.parse("2026-10-26T07:00:00.000Z");

function androidRows(packageName: string) {
  return androidUsageRowsFromSignals(
    [
      {
        metadata: {
          screenTime: {
            granted: true,
            topApps: [{ packageName, totalTimeForegroundMs: 1_800_000 }],
          },
        },
      },
    ],
    sinceMs,
    untilMs,
  );
}

// "messenger" names Facebook Messenger, but it is also a word in other apps'
// ids: Telegram for Android ships as org.telegram.messenger.
describe("screen-time service for app ids that contain 'messenger'", () => {
  it("counts Telegram for Android as Telegram, not Facebook", () => {
    const breakdown = buildScreenTimeBreakdown(
      androidRows("org.telegram.messenger"),
    );

    expect(breakdown.items).toEqual([
      expect.objectContaining({
        identifier: "org.telegram.messenger",
        service: "telegram",
        serviceLabel: "Telegram",
        category: "communication",
        device: "phone",
      }),
    ]);
    expect(breakdown.byService.map((bucket) => bucket.key)).toEqual([
      "telegram",
    ]);
  });

  it("still counts Facebook Messenger for Android as Facebook", () => {
    const breakdown = buildScreenTimeBreakdown(
      androidRows("com.facebook.orca"),
    );

    expect(breakdown.items).toEqual([
      expect.objectContaining({ service: "facebook", category: "social" }),
    ]);
  });

  it("still counts messenger.com as Facebook", () => {
    expect(
      classifyScreenTimeTarget({
        source: "website",
        identifier: "www.messenger.com",
        displayName: "www.messenger.com",
        metadata: { url: "https://www.messenger.com/t/123" },
      }),
    ).toMatchObject({ service: "facebook", category: "social" });
  });
});
