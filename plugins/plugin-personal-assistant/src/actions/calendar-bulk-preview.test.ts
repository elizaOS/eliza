/** Tests that bulk-reschedule approval previews enumerate the complete cohort. */

import type { LifeOpsCalendarEvent } from "@elizaos/shared/contracts/personal-assistant";
import { describe, expect, it } from "vitest";
import { formatBulkReschedulePreviewLines } from "./calendar-preview.js";

describe("bulk reschedule preview", () => {
  it("includes every affected event beyond the former eight-item cap", () => {
    const events = Array.from({ length: 11 }, (_, index) => ({
      id: `event-${index}`,
      title: `Partnership meeting ${index}`,
      startAt: `2026-09-${String(index + 1).padStart(2, "0")}T17:00:00.000Z`,
      endAt: `2026-09-${String(index + 1).padStart(2, "0")}T18:00:00.000Z`,
      timezone: "UTC",
      isAllDay: false,
    })) as LifeOpsCalendarEvent[];

    const lines = formatBulkReschedulePreviewLines(events);
    expect(lines).toHaveLength(11);
    expect(lines.at(-1)).toContain("Partnership meeting 10");
  });
});
