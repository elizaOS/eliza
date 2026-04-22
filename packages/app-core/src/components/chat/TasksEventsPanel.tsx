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

import { PanelRightClose, PanelRightOpen } from "lucide-react";
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
        className="w-0 min-w-0 shrink-0"
        data-testid="chat-widgets-bar"
        data-collapsed
      >
        <button
          type="button"
          data-testid="chat-widgets-expand-floating"
          className="fixed bottom-3 right-3 z-40 inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-sm)] border border-border/40 bg-card/85 text-muted shadow-md backdrop-blur-md transition-colors hover:border-border/60 hover:text-txt"
          aria-label="Expand widgets"
          onClick={() => onToggleCollapsed?.(false)}
        >
          <PanelRightOpen className="h-4 w-4" />
        </button>
      </aside>
    );
  }

  const rootClassName = mobile
    ? "flex flex-1 min-h-0 flex-col overflow-hidden bg-bg"
    : "flex min-h-0 w-[22rem] shrink-0 flex-col overflow-hidden border-l border-border/30 bg-bg";

  const showCollapseFooter = !mobile && Boolean(onToggleCollapsed);

  return (
    <aside className={rootClassName} data-testid="chat-widgets-bar">
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
        <div className="flex flex-col gap-3">
          <AppsSection />
          <WidgetHost
            slot="chat-sidebar"
            events={events}
            clearEvents={clearEvents}
            hideWhenEmpty={false}
          />
        </div>
      </div>
      {showCollapseFooter ? (
        <div className="flex items-center justify-end border-t border-border/30 pl-2 pr-2 pt-1.5 pb-2">
          <button
            type="button"
            data-testid="chat-widgets-collapse-inline"
            className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt"
            aria-label="Collapse widgets"
            onClick={() => onToggleCollapsed?.(true)}
          >
            <PanelRightClose className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      ) : null}
    </aside>
  );
}
