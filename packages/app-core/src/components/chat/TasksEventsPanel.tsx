/**
 * Chat workspace widget bar.
 *
 * Desktop: persistent right rail alongside /chat.
 * Mobile: alternate chat workspace view toggled from the chat header.
 *
 * Renders the `chat-sidebar` widget slot via the plugin widget system.
 */

import type { ActivityEvent } from "../../hooks/useActivityEvents";
import { WidgetHost } from "../../widgets";
import { AppsSection } from "./AppsSection";

interface TasksEventsPanelProps {
  open: boolean;
  /** Activity events from the parent — kept alive even when the panel unmounts. */
  events: ActivityEvent[];
  clearEvents: () => void;
  /** When true, renders as full-width mobile content. */
  mobile?: boolean;
}

export function TasksEventsPanel({
  open,
  events,
  clearEvents,
  mobile = false,
}: TasksEventsPanelProps) {
  if (!open) return null;

  const rootClassName = mobile
    ? "flex flex-1 min-h-0 flex-col overflow-hidden bg-bg"
    : "flex min-h-0 w-[22rem] shrink-0 flex-col overflow-hidden";

  return (
    <aside className={rootClassName} data-testid="chat-widgets-bar">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        <AppsSection />
        <WidgetHost
          slot="chat-sidebar"
          events={events}
          clearEvents={clearEvents}
          hideWhenEmpty={false}
        />
      </div>
    </aside>
  );
}
