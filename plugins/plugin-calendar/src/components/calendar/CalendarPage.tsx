/**
 * Composes the plugin-owned Calendar view with the shared shell navigation
 * primitive. Calendar owns its route chrome; the app shell only mounts the
 * registered plugin surface.
 */

import type { LifeOpsCalendarEvent } from "@elizaos/shared";
import { PluginPageFrame } from "@elizaos/ui/components";
import type { JSX } from "react";
import { useCallback, useState } from "react";
import { CalendarSection } from "../CalendarSection.tsx";

export function CalendarPage(): JSX.Element {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const getPrimedEvent = useCallback(
    (_eventId: string): LifeOpsCalendarEvent | null => null,
    [],
  );

  return (
    <PluginPageFrame title="Calendar" safeAreaTop>
      <div
        className="h-full min-h-0 min-w-0 overflow-auto px-3 py-3 sm:px-5 sm:py-4"
        data-scroll-cert-scroller
      >
        <CalendarSection
          selectedEventId={selectedEventId}
          onSelectEvent={setSelectedEventId}
          getPrimedEvent={getPrimedEvent}
        />
      </div>
    </PluginPageFrame>
  );
}
