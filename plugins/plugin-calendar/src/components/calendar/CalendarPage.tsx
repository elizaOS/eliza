/**
 * Composes the plugin-owned Calendar view with the shared shell navigation
 * primitive. Calendar owns its route chrome; the app shell only mounts the
 * registered plugin surface.
 */

import { PluginPageFrame } from "@elizaos/ui/components";
import { type JSX, useState } from "react";
import { CalendarSection } from "../CalendarSection.tsx";

// Route-local selections come from the current feed, without an external prime cache.
const getPrimedEvent = () => null;

export function CalendarPage(): JSX.Element {
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  return (
    <PluginPageFrame title="Calendar" safeAreaTop contentOverflow="auto">
      <div className="p-3 md:p-4">
        <CalendarSection
          selectedEventId={selectedEventId}
          onSelectEvent={setSelectedEventId}
          getPrimedEvent={getPrimedEvent}
        />
      </div>
    </PluginPageFrame>
  );
}
