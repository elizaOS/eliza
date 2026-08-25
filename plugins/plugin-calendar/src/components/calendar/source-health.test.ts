import type { LifeOpsCalendarSourceHealth } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import {
  calendarCoverageHeadline,
  toCalendarSourceHealthRows,
} from "./source-health";

function source(
  overrides: Partial<LifeOpsCalendarSourceHealth> &
    Pick<LifeOpsCalendarSourceHealth, "key" | "status" | "summary">,
): LifeOpsCalendarSourceHealth {
  return {
    syncedAt: null,
    ...overrides,
  } as LifeOpsCalendarSourceHealth;
}

const googleKey = {
  provider: "google",
  side: "primary",
  grantId: "g1",
  connectorAccountId: "acct-1",
  calendarId: "cal-1",
} as const;

const NOW = new Date("2026-08-25T12:00:00.000Z");

describe("toCalendarSourceHealthRows (privacy-minimized rows)", () => {
  it("maps a fresh google source to a success row with provider label", () => {
    const rows = toCalendarSourceHealthRows(
      [
        source({
          key: googleKey,
          status: "fresh",
          summary: "Inbox",
          syncedAt: "2026-08-25T11:50:00.000Z",
        }),
      ],
      NOW,
    );
    expect(rows[0]).toMatchObject({
      id: "google:primary:g1:acct-1:cal-1",
      label: "Google · Inbox",
      status: "fresh",
      statusLabel: "Current",
      tone: "success",
    });
    expect(rows[0].freshnessLabel).toBe("10m ago");
  });

  it("never surfaces raw provider errors or event details in row copy", () => {
    const rows = toCalendarSourceHealthRows(
      [
        source({
          key: googleKey,
          status: "error",
          summary: "Inbox",
          syncedAt: "2026-08-25T11:00:00.000Z",
        }),
      ],
      NOW,
    );
    expect(rows[0].statusLabel).toBe("Update failed");
    expect(rows[0].tone).toBe("danger");
    expect(rows[0].freshnessLabel).toContain("failed · last 1h ago");
    expect(JSON.stringify(rows[0])).not.toContain("provider error");
  });

  it("reports unknown sync time for missing or unparseable syncedAt", () => {
    const rows = toCalendarSourceHealthRows(
      [
        source({ key: googleKey, status: "fresh", summary: "Inbox" }),
        source({
          key: googleKey,
          status: "stale",
          summary: "Inbox",
          syncedAt: "not-a-date",
        }),
      ],
      NOW,
    );
    expect(rows[0].freshnessLabel).toBe("sync time unknown");
    expect(rows[1].freshnessLabel).toBe("stale · sync time unknown");
  });

  it("maps stale and disconnected sources with warning/muted tones", () => {
    const rows = toCalendarSourceHealthRows(
      [
        source({
          key: googleKey,
          status: "stale",
          summary: "Inbox",
          syncedAt: "2026-08-25T06:00:00.000Z",
        }),
        source({ key: googleKey, status: "disconnected", summary: "Inbox" }),
      ],
      NOW,
    );
    expect(rows[0]).toMatchObject({
      statusLabel: "Stale",
      tone: "warning",
    });
    expect(rows[0].freshnessLabel).toContain("stale · 6h ago");
    expect(rows[1]).toMatchObject({
      statusLabel: "Disconnected",
      freshnessLabel: "disconnected",
      tone: "muted",
    });
  });

  it("hides elapsed freshness for eliza-local fresh sources", () => {
    const rows = toCalendarSourceHealthRows(
      [
        source({
          key: { ...googleKey, provider: "eliza" },
          status: "fresh",
          summary: "Local",
          syncedAt: "2026-08-25T11:59:00.000Z",
        }),
      ],
      NOW,
    );
    expect(rows[0].freshnessLabel).toBe("stored locally");
  });

  it("renders an error source with no cache distinctly", () => {
    const rows = toCalendarSourceHealthRows(
      [
        source({
          key: googleKey,
          status: "error",
          summary: "Inbox",
        }),
      ],
      NOW,
    );
    expect(rows[0].freshnessLabel).toBe("failed · no cache");
  });

  it("trims summary and falls back to the provider label when empty", () => {
    const rows = toCalendarSourceHealthRows(
      [
        source({ key: googleKey, status: "fresh", summary: "  Inbox  " }),
        source({ key: googleKey, status: "fresh", summary: "   " }),
      ],
      NOW,
    );
    expect(rows[0].label).toBe("Google · Inbox");
    expect(rows[1].label).toBe("Google");
  });

  it("formats days-old sources as a calendar date, adding the year across years", () => {
    const sameYear = new Date("2026-08-15T00:00:00.000Z");
    const crossYear = new Date("2025-12-31T00:00:00.000Z");
    const rows = toCalendarSourceHealthRows(
      [
        source({
          key: googleKey,
          status: "fresh",
          summary: "Inbox",
          syncedAt: sameYear.toISOString(),
        }),
        source({
          key: googleKey,
          status: "fresh",
          summary: "Inbox",
          syncedAt: crossYear.toISOString(),
        }),
      ],
      NOW,
    );
    expect(rows[0].freshnessLabel).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
    expect(rows[1].freshnessLabel).toContain("2025");
    expect(rows[1].freshnessLabel).not.toContain("NaN");
  });

  it("labels sub-minute and future-skewed syncs as just now", () => {
    const rows = toCalendarSourceHealthRows(
      [
        source({
          key: googleKey,
          status: "fresh",
          summary: "Inbox",
          syncedAt: "2026-08-25T11:59:30.000Z",
        }),
        source({
          key: googleKey,
          status: "fresh",
          summary: "Inbox",
          syncedAt: "2026-08-25T12:05:00.000Z",
        }),
      ],
      NOW,
    );
    expect(rows[0].freshnessLabel).toBe("just now");
    expect(rows[1].freshnessLabel).toBe("just now");
  });
});

describe("calendarCoverageHeadline", () => {
  const freshRow = {
    id: "google:primary:g1:acct-1:cal-1",
    label: "Google",
    status: "fresh",
    statusLabel: "Current",
    freshnessLabel: "just now",
    tone: "success",
  } as const;

  it("reflects refresh and loading states", () => {
    expect(calendarCoverageHeadline("loading", [], false)).toBe(
      "Checking calendar sources",
    );
    expect(calendarCoverageHeadline("loading", [], true)).toBe(
      "Refreshing calendar sources",
    );
  });

  it("distinguishes refresh failure with and without known sources", () => {
    expect(calendarCoverageHeadline("error", [freshRow], false)).toBe(
      "Calendar refresh failed",
    );
    expect(calendarCoverageHeadline("error", [], false)).toBe(
      "Calendar sources could not load",
    );
  });

  it("reports unavailable surface", () => {
    expect(calendarCoverageHeadline("unavailable", [], false)).toBe(
      "Calendar sources unavailable",
    );
  });

  it("keeps singular/plural grammar for partial coverage", () => {
    const staleRow = { ...freshRow, status: "stale" };
    expect(
      calendarCoverageHeadline("partial", [freshRow, staleRow], false),
    ).toBe("Partial calendar · 1 source needs attention");
    expect(
      calendarCoverageHeadline(
        "partial",
        [freshRow, staleRow, staleRow],
        false,
      ),
    ).toBe("Partial calendar · 2 sources need attention");
  });

  it("keeps singular/plural grammar for ready coverage", () => {
    expect(calendarCoverageHeadline("ready", [freshRow], false)).toBe(
      "1 source current",
    );
    expect(calendarCoverageHeadline("ready", [freshRow, freshRow], false)).toBe(
      "2 sources current",
    );
    expect(calendarCoverageHeadline("ready", [], false)).toBe(
      "No source details reported",
    );
    expect(calendarCoverageHeadline("empty", [], false)).toBe(
      "No source details reported",
    );
  });
});
