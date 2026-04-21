/**
 * Chat workspace widget bar.
 *
 * Desktop: persistent right rail alongside /chat. Collapses to a thin strip
 *          with an expand chevron, matching the AppWorkspaceChrome pattern
 *          used by the Browser / LifeOps right-chat sidebar.
 * Mobile:  alternate chat workspace view toggled from the chat header.
 *          No collapse affordance — parent hides the panel entirely.
 *
 * Renders the `chat-sidebar` widget slot via the plugin widget system.
 */

import { ChevronLeft, ChevronRight, LayoutGrid } from "lucide-react";
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
  /** Desktop-only: when true the panel collapses to a thin strip. */
  collapsed?: boolean;
  /** Desktop-only: called when the user toggles the collapsed state. */
  onToggleCollapsed?: (next: boolean) => void;
}

export function TasksEventsPanel({
  open,
  events,
  clearEvents,
  mobile = false,
  collapsed = false,
  onToggleCollapsed,
}: TasksEventsPanelProps) {
  if (!open) return null;

  if (!mobile && collapsed) {
    return (
      <aside
        className="flex w-10 shrink-0 flex-col border-l border-border/30 bg-bg"
        data-testid="chat-widgets-bar"
      >
        <div className="flex h-10 items-center justify-center border-b border-border/30">
          <button
            type="button"
            className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-card/60 hover:text-txt"
            aria-label="Expand widgets"
            onClick={() => onToggleCollapsed?.(false)}
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
        </div>
      </aside>
    );
  }

  const rootClassName = mobile
    ? "flex flex-1 min-h-0 flex-col overflow-hidden bg-bg"
    : "flex min-h-0 w-[22rem] shrink-0 flex-col overflow-hidden border-l border-border/30 bg-bg";

  return (
    <aside className={rootClassName} data-testid="chat-widgets-bar">
      {!mobile ? (
        <div className="flex h-10 items-center justify-between border-b border-border/30 px-2">
          <div className="flex items-center gap-1.5 px-1 text-xs font-semibold uppercase tracking-wider text-muted">
            <LayoutGrid className="h-3.5 w-3.5" />
            Widgets
          </div>
          {onToggleCollapsed ? (
            <button
              type="button"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-card/60 hover:text-txt"
              aria-label="Collapse widgets"
              onClick={() => onToggleCollapsed(true)}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ) : null}
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
