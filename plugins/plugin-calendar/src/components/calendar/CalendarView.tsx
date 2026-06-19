/**
 * CalendarView — registered top-level calendar overlay view.
 *
 * Thin host wrapper around the rich `CalendarSection`: CalendarSection owns the
 * prev/today/next nav, the day/week/month SegmentedControl, the "New" button,
 * the time/month/agenda grids, and the `EventEditorDrawer` — all instrumented
 * through `useAgentElement` so the floating chat can drive them. This wrapper
 * only owns the selection id the section reports back, and routes a
 * chat-about-event request through the shared `setActionNotice` affordance.
 *
 * `getPrimedEvent` returns `null`: there is no deep-link / widget prime cache in
 * this view yet, so CalendarSection resolves selected events from the loaded
 * feed only. That is the honest behavior — no fabricated cache.
 */

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { useApp } from "@elizaos/ui";
import type { ReactElement } from "react";
import { useCallback, useState } from "react";
import { CalendarSection } from "../CalendarSection.js";

export function CalendarView(): ReactElement {
  const { setActionNotice } = useApp();
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);

  const handleChatAboutEvent = useCallback(
    (event: LifeOpsCalendarEvent) => {
      // The event buttons are already agent-surface instrumented, so the
      // floating chat can act on the selected event. Surface a notice that
      // points the user at the assistant rather than fabricating a launcher
      // this view doesn't own.
      setActionNotice(
        `Ask the assistant about “${event.title}”.`,
        "info",
        4000,
      );
    },
    [setActionNotice],
  );

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        padding: "1.5rem",
        boxSizing: "border-box",
        background: "var(--background, #0a0a0a)",
        color: "var(--foreground, #f5f5f5)",
      }}
      data-testid="calendar-view"
    >
      <CalendarSection
        selectedEventId={selectedEventId}
        onSelectEvent={setSelectedEventId}
        onChatAboutEvent={handleChatAboutEvent}
        getPrimedEvent={() => null}
      />
    </div>
  );
}

export default CalendarView;
