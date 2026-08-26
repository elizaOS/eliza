/**
 * Composes the plugin-owned Calendar view with the shared shell navigation
 * primitive. Calendar owns its route chrome; the app shell only mounts the
 * registered plugin surface.
 */

import { ViewHeader } from "@elizaos/ui/components";
import type { JSX } from "react";
import { SimpleCalendarView } from "./SimpleCalendarView.tsx";

export function CalendarPage(): JSX.Element {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      <ViewHeader title="Calendar" />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <SimpleCalendarView />
      </div>
    </div>
  );
}
