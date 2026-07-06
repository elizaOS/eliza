/**
 * Standardized collapsible shell every inline chat widget wraps: a header
 * (title + status chip + chevron), an expanded body, and a compact collapsed
 * summary row. It bounds the vertical space a widget eats in the transcript by
 * enforcing one contract — start EXPANDED while the widget's job is incomplete,
 * AUTO-COLLAPSE to the summary once it reports complete/connected — while still
 * letting the user re-expand via the chevron.
 *
 * Consumed by the connector-setup widget (and any future inline widget that
 * needs the same expand/collapse discipline) through `MessageContent`'s
 * registry render path. The `complete` flag is the single source of the
 * default-collapse decision; the user's manual toggle after that overrides it,
 * so a connected widget the user re-opened stays open. Collapsed bodies carry
 * `content-visibility:auto` so an off-screen collapsed widget is skipped by
 * layout/paint until scrolled into view — this is why collapsing a widget in a
 * long transcript does not repaint sibling rows.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";

export interface ChatWidgetShellProps {
  /** Marker title shown in the header, e.g. the connector name. */
  title: string;
  /** Icon rendered left of the title. */
  icon?: ReactNode;
  /** Status chip on the right of the header (connection/config state). */
  status?: ReactNode;
  /**
   * Whether the widget's job is done (connected/configured). Drives the default
   * expansion: incomplete → expanded, complete → collapsed. A later user toggle
   * wins over this default until `complete` transitions again.
   */
  complete: boolean;
  /** Compact one-line summary shown when collapsed. */
  summary: ReactNode;
  /** Expanded body — the full setup form / panel. */
  children: ReactNode;
  /** Stable test id prefix for the shell subtree. */
  testId?: string;
}

/**
 * Renders the shell. Expansion is uncontrolled: it defaults from `complete` and
 * re-syncs only when `complete` itself flips (so the auto-collapse fires exactly
 * once on connect, not on every unrelated re-render).
 */
export function ChatWidgetShell({
  title,
  icon,
  status,
  complete,
  summary,
  children,
  testId = "chat-widget-shell",
}: ChatWidgetShellProps) {
  const [expanded, setExpanded] = useState(!complete);
  // Track the last `complete` we reacted to so a re-render with an unchanged
  // flag never clobbers a manual toggle; only a real transition re-derives.
  const lastComplete = useRef(complete);
  useEffect(() => {
    if (lastComplete.current !== complete) {
      lastComplete.current = complete;
      setExpanded(!complete);
    }
  }, [complete]);

  const Chevron = expanded ? ChevronDown : ChevronRight;

  return (
    <div
      data-testid={testId}
      data-complete={complete}
      data-expanded={expanded}
      className="my-2 rounded-sm border border-border bg-card"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          data-testid={`${testId}-toggle`}
          className="h-auto min-w-0 flex-1 justify-start gap-2 rounded-sm bg-transparent px-0 py-0.5 text-left transition-colors hover:bg-transparent hover:text-txt"
        >
          {icon ? (
            <span className="inline-flex shrink-0 items-center justify-center text-muted [&>svg]:h-4 [&>svg]:w-4">
              {icon}
            </span>
          ) : null}
          <span className="truncate text-sm font-semibold text-txt">
            {title}
          </span>
          <Chevron aria-hidden className="h-4 w-4 shrink-0 text-muted" />
        </Button>
        {status ? <div className="shrink-0">{status}</div> : null}
      </div>
      {expanded ? (
        <div className="px-3 pb-3 pt-1" data-testid={`${testId}-body`}>
          {children}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          data-testid={`${testId}-summary`}
          // content-visibility:auto lets the browser skip layout/paint of this
          // collapsed row while it is off-screen in a long transcript.
          className={cn(
            "flex w-full items-center gap-2 border-t border-border px-3 py-2 text-left text-xs text-muted transition-colors hover:text-txt",
            "[content-visibility:auto] [contain-intrinsic-size:auto_2rem]",
          )}
        >
          {summary}
        </button>
      )}
    </div>
  );
}
