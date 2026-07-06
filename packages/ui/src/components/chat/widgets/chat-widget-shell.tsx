/**
 * Standardized collapsible shell for chat-transcript widgets (#14412): a header
 * row (icon + title + status slot + chevron), an expanded body, and a compact
 * collapsed summary row, so a widget stops eating transcript height once its
 * job is done.
 *
 * Contract: the widget starts expanded while its job is incomplete and
 * auto-collapses to the summary when `complete` flips true (a connector
 * reaching connected status, a form submitted). The chevron re-expands it at
 * any time, and a user toggle sticks until the next `complete` transition.
 *
 * The body stays MOUNTED while collapsed — hidden with `display:none` plus a
 * `content-visibility:hidden` hint — so in-progress field edits survive a
 * collapse/expand round-trip and the collapsed subtree costs no layout/paint
 * per transcript frame. `contain:content` on the root keeps a widget's
 * internal relayouts from propagating into the transcript (only the shell's
 * own size changes reach the flow, which is exactly the expand/collapse case).
 */
import { ChevronDown } from "lucide-react";
import { type CSSProperties, type ReactNode, useId, useState } from "react";
import { useAppSelector } from "../../../state";

export interface ChatWidgetShellProps {
  /** Header title (plain text or inline nodes); truncates rather than wraps. */
  title: ReactNode;
  /** Optional leading icon/emoji slot rendered before the title. */
  icon?: ReactNode;
  /** Status chips rendered on the header's trailing edge, before the chevron. */
  status?: ReactNode;
  /** Compact one-row content shown instead of the body while collapsed. */
  summary?: ReactNode;
  /**
   * True once the widget's job is done (connected / submitted / resolved).
   * Drives the initial expansion and the auto-collapse/auto-expand transitions.
   */
  complete: boolean;
  /** The full widget body. Stays mounted (hidden) while collapsed. */
  children: ReactNode;
  testId?: string;
}

// Kept inert so unsupporting engines simply ignore the hint; `display:none`
// is what universally removes the collapsed body from layout.
const COLLAPSED_BODY_STYLE: CSSProperties = {
  display: "none",
  contentVisibility: "hidden",
};

export function ChatWidgetShell({
  title,
  icon,
  status,
  summary,
  complete,
  children,
  testId,
}: ChatWidgetShellProps) {
  const t = useAppSelector((s) => s.t);
  const bodyId = useId();
  const [expanded, setExpanded] = useState(!complete);
  // Render-time adjustment (not an effect) so a completion transition never
  // paints one expanded frame before collapsing. A transition in either
  // direction resets the user's manual toggle: connect collapses, a later
  // disconnect re-opens the setup form.
  const [prevComplete, setPrevComplete] = useState(complete);
  if (prevComplete !== complete) {
    setPrevComplete(complete);
    setExpanded(!complete);
  }

  return (
    <div
      className="my-2 border border-border bg-card overflow-hidden [contain:content]"
      data-testid={testId}
      data-expanded={expanded}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-bg-hover">
        <div className="flex min-w-0 items-center gap-2 text-xs font-bold text-txt">
          {icon}
          <span className="truncate">{title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status}
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={bodyId}
            aria-label={
              expanded
                ? t("chatwidget.Collapse", { defaultValue: "Collapse" })
                : t("chatwidget.Expand", { defaultValue: "Expand" })
            }
            data-testid={testId ? `${testId}-chevron` : undefined}
            className="flex size-5 items-center justify-center text-muted transition-colors hover:text-txt"
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDown
              className={`size-3.5 transition-transform duration-200 ${expanded ? "" : "-rotate-90"}`}
            />
          </button>
        </div>
      </div>
      {!expanded && summary != null && (
        <div
          className="truncate px-3 py-2 text-xs text-muted"
          data-testid={testId ? `${testId}-summary` : undefined}
        >
          {summary}
        </div>
      )}
      <div
        id={bodyId}
        aria-hidden={!expanded}
        style={expanded ? undefined : COLLAPSED_BODY_STYLE}
        data-testid={testId ? `${testId}-body` : undefined}
      >
        {children}
      </div>
    </div>
  );
}
