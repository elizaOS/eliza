/**
 * Verifies calendar source-health copy at the untrusted feed boundary,
 * including sparse local-source payloads produced by older runtimes.
 */

import type { LifeOpsCalendarSourceHealth } from "@elizaos/shared";
import { describe, expect, it } from "vitest";
import { toCalendarSourceHealthRows } from "./source-health.js";

describe("toCalendarSourceHealthRows", () => {
  it("never exposes an undefined provider label for a sparse local source", () => {
    const source = {
      key: {
        side: "owner",
        grantId: "eliza-local",
        connectorAccountId: "eliza-local",
        calendarId: "eliza-local",
      },
      summary: "Eliza Calendar",
      accessRole: "owner",
      visibility: "details",
      status: "fresh",
      syncedAt: "2026-08-31T12:00:00.000Z",
      error: null,
    } as unknown as LifeOpsCalendarSourceHealth;

    const [row] = toCalendarSourceHealthRows(
      [source],
      new Date("2026-08-31T12:00:30.000Z"),
    );

    expect(row.label).toBe("Calendar · Eliza Calendar");
    expect(row.label).not.toContain("undefined");
  });
});
