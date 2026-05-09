/**
 * Chat workspace widget bar.
 *
 * Desktop: persistent right rail alongside /chat. Collapses to a thin strip
 *          with a floating expand button. The footer carries the panel
 *          collapse and an Edit affordance that opens the visibility panel
 *          where the user picks which widgets show.
 * Mobile:  alternate chat workspace view toggled from the chat header. No
 *          collapse / edit affordances — parent hides the panel entirely.
 *
 * Renders the `chat-sidebar` widget slot via the plugin widget system,
 * filtered through `useChatSidebarVisibility` so user overrides apply.
 */

import { PanelRightClose, PanelRightOpen, Pencil } from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import type { ActivityEvent } from "../../hooks/useActivityEvents";
import { useApp } from "../../state";
// Direct sub-path import for WidgetHost to avoid the widgets/index.ts ↔
// WidgetHost.tsx chunk-level cycle. The barrel still works fine for
// resolveWidgetsForSlot — only WidgetHost participates in the cycle.
import { resolveWidgetsForSlot } from "../../widgets";
import { useChatSidebarVisibility } from "../../widgets/useChatSidebarVisibility";
import {
  APPS_SECTION_VISIBILITY_KEY,
  isWidgetVisible,
  type VisibilityCandidate,
} from "../../widgets/visibility";
import { WidgetHost } from "../../widgets/WidgetHost";
import { AppsSection } from "./AppsSection";
import {
  buildAppsSectionVisibilityCandidate,
  type WidgetVisibilityCandidate,
  WidgetVisibilityEditor,
} from "./WidgetVisibilityPanel";

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
  const { plugins } = useApp();
  const visibility = useChatSidebarVisibility();
  const [editOpen, setEditOpen] = useState(false);

  const WIDGETS_WIDTH_KEY = "eliza:chat:widgets-bar:width";
  const WIDGETS_DEFAULT_WIDTH = 320;
  const WIDGETS_MIN_WIDTH = 240;
  const WIDGETS_MAX_WIDTH = 560;
  const [widgetsWidth, setWidgetsWidth] = useState<number>(() => {
    if (typeof window === "undefined") return WIDGETS_DEFAULT_WIDTH;
    try {
      const raw = window.localStorage.getItem(WIDGETS_WIDTH_KEY);
      const parsed = raw ? Number.parseInt(raw, 10) : NaN;
      if (Number.isFinite(parsed)) {
        return Math.min(Math.max(parsed, WIDGETS_MIN_WIDTH), WIDGETS_MAX_WIDTH);
      }
    } catch {
      /* ignore */
    }
    return WIDGETS_DEFAULT_WIDTH;
  });
  const applyWidgetsWidth = useCallback((next: number) => {
    setWidgetsWidth(next);
    try {
      window.localStorage.setItem(WIDGETS_WIDTH_KEY, String(next));
    } catch {
      /* ignore */
    }
  }, []);
  const collapseThreshold = Math.max(WIDGETS_MIN_WIDTH - 40, 80);
  const handleResizePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (mobile || collapsed) return;
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = widgetsWidth;
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
      const onMove = (ev: PointerEvent) => {
        const delta = ev.clientX - startX;
        // Dragging left increases width (handle is on the left edge of the right sidebar).
        const nextRaw = startWidth - delta;
        if (nextRaw < collapseThreshold && onToggleCollapsed) {
          onToggleCollapsed(true);
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          return;
        }
        const clamped = Math.min(
          Math.max(nextRaw, WIDGETS_MIN_WIDTH),
          WIDGETS_MAX_WIDTH,
        );
        applyWidgetsWidth(clamped);
      };
      const onUp = () => {
        try {
          target.releasePointerCapture(event.pointerId);
        } catch {
          /* ignore */
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [
      applyWidgetsWidth,
      collapseThreshold,
      collapsed,
      mobile,
      onToggleCollapsed,
      widgetsWidth,
    ],
  );

  // Apps section is bespoke (not a registry widget) but participates in the
  // same edit panel via a synthetic candidate.
  const appsCandidate = useMemo(
    () => buildAppsSectionVisibilityCandidate(),
    [],
  );

  // Build the candidate list for the edit panel from the live registry.
  const editCandidates = useMemo<readonly WidgetVisibilityCandidate[]>(() => {
    const resolved = resolveWidgetsForSlot("chat-sidebar", plugins ?? []);
    const widgetCandidates: WidgetVisibilityCandidate[] = resolved.map(
      ({ declaration }) => ({
        pluginId: declaration.pluginId,
        id: declaration.id,
        defaultEnabled: declaration.defaultEnabled,
        label: declaration.label,
      }),
    );
    return [appsCandidate, ...widgetCandidates];
  }, [appsCandidate, plugins]);

  const widgetFilter = useCallback(
    (declaration: VisibilityCandidate) =>
      isWidgetVisible(declaration, visibility.overrides),
    [visibility.overrides],
  );

  const showAppsSection = visibility.isVisible(appsCandidate);

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
          className="fixed bottom-3 right-3 z-40 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt"
          aria-label="Expand widgets"
          onClick={() => onToggleCollapsed?.(false)}
        >
          <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
        </button>
      </aside>
    );
  }

  const rootClassName = mobile
    ? "flex flex-1 min-h-0 flex-col overflow-hidden bg-bg"
    : "relative flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-border/30 bg-bg";
  const rootStyle: React.CSSProperties | undefined = mobile
    ? undefined
    : { width: `${widgetsWidth}px`, minWidth: `${widgetsWidth}px` };

  const showFooter = !mobile;
  const showCollapseButton = !mobile && Boolean(onToggleCollapsed);

  return (
    <aside
      className={rootClassName}
      data-testid="chat-widgets-bar"
      style={rootStyle}
    >
      {!mobile ? (
        <hr
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={50}
          tabIndex={0}
          data-testid="chat-widgets-resize-handle"
          onPointerDown={handleResizePointerDown}
          className="absolute inset-y-0 left-0 z-20 m-0 h-full w-3 -ml-1.5 cursor-col-resize touch-none select-none border-0 bg-transparent transition-colors hover:bg-accent/20"
        />
      ) : null}
      {editOpen ? (
        <WidgetVisibilityEditor
          candidates={editCandidates}
          visibility={visibility}
          onClose={() => setEditOpen(false)}
        />
      ) : (
        <>
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3">
            <div className="flex flex-col gap-3">
              {showAppsSection ? <AppsSection /> : null}
              <WidgetHost
                slot="chat-sidebar"
                events={events}
                clearEvents={clearEvents}
                hideWhenEmpty={false}
                filter={widgetFilter}
              />
            </div>
          </div>
          {showFooter ? (
            <div className="flex items-center justify-between border-t border-border/30 pl-2 pr-2 pt-1.5 pb-2">
              <button
                type="button"
                data-testid="chat-widgets-edit-inline"
                className="inline-flex h-5 shrink-0 items-center gap-1 rounded-[var(--radius-sm)] bg-transparent px-1 text-[10px] leading-none font-semibold uppercase tracking-[0.1em] text-muted transition-colors hover:text-txt"
                aria-label="Edit widgets"
                onClick={() => setEditOpen(true)}
              >
                <Pencil className="h-3 w-3" aria-hidden />
                <span>Widgets</span>
              </button>
              {showCollapseButton ? (
                <button
                  type="button"
                  data-testid="chat-widgets-collapse-inline"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] bg-transparent text-muted transition-colors hover:text-txt"
                  aria-label="Collapse widgets"
                  onClick={() => onToggleCollapsed?.(true)}
                >
                  <PanelRightClose className="h-3.5 w-3.5" aria-hidden />
                </button>
              ) : (
                <span className="h-6 w-6" />
              )}
            </div>
          ) : null}
        </>
      )}
    </aside>
  );
}

// Re-export the Apps section visibility key so other modules can reference it
// without depending on the panel module directly.
export { APPS_SECTION_VISIBILITY_KEY };
