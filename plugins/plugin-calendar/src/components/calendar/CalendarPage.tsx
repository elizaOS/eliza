/**
 * Composes the plugin-owned Calendar view with the shared shell navigation
 * primitive. Calendar owns its route chrome; the app shell only mounts the
 * registered plugin surface.
 */

import { ViewHeader } from "@elizaos/ui/components";
import { type JSX, useState } from "react";
import { CalendarSection } from "../CalendarSection.tsx";

// Route-local selections come from the current feed, without an external prime cache.
const getPrimedEvent = () => null;

export function CalendarPage(): JSX.Element {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden pt-[var(--safe-area-top,0px)]">
      <ViewHeader title="Calendar" />
      <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3 md:p-4">
        <CalendarSection
          selectedEventId={selectedEventId}
          onSelectEvent={setSelectedEventId}
          getPrimedEvent={getPrimedEvent}
        />
      </div>
    </div>
  );
}
