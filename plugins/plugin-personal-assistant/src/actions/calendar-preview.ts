/** Formats every affected event for model-visible bulk calendar approvals. */

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { formatCalendarEventDateTime } from "../lifeops/google/format-helpers.js";

export function formatBulkReschedulePreviewLines(
  matches: readonly LifeOpsCalendarEvent[],
): string[] {
  return matches.map((event) => {
    const when = formatCalendarEventDateTime(event, {
      includeTimeZoneName: true,
    });
    return `- ${event.title || "Untitled"} — ${when}`;
  });
}
