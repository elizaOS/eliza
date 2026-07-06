/**
 * CalendarCountdown, a leaf that renders the "in 40 min" countdown string for
 * the Up Next home card and owns its OWN minute ticker, so the card shell never
 * re-renders on the tick (§C.4 of NOTIFICATIONS-WIDGETS-SYSTEM.md: timers live
 * in `<RelativeTime>`-class leaves only, never above them).
 *
 * COORDINATION (#14559): the shared `<RelativeTime>` leaf is being built in a
 * parallel lane. This leaf deliberately mirrors its props shape (`date` +
 * optional injected `now` for tests) so the swap is a one-liner once #14559
 * lands: replace the import and pass `date={next.startAt}`. Until then this is
 * a self-contained, visibility-gated ticker, NOT a competing shared-ticker
 * infrastructure.
 */
import { type JSX, useEffect, useState } from "react";
import { useDocumentVisibility } from "../../../hooks";

// The countdown re-formats on the same calm 60s cadence the calendar feed polls.
// A per-minute string is precise enough for "in 40 min" and burns one local
// timer only while the document is visible.
const COUNTDOWN_TICK_MS = 60_000;

function useVisibilityGatedNow(intervalMs: number): number {
  const documentVisible = useDocumentVisibility();
  const [now, setNow] = useState(0);

  useEffect(() => {
    if (!documentVisible) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [documentVisible, intervalMs]);

  return now;
}

/**
 * Compact relative time until an event, e.g. "now", "in 25m", "in 3h",
 * "tomorrow", "in 2d". Sentence case, no em-dashes (spec copy law). Exported so
 * the card's `ariaLabel` can render the same string without mounting the leaf.
 */
export function formatCountdown(date: string, now: number): string {
  const deltaMs = Date.parse(date) - now;
  if (!Number.isFinite(deltaMs)) return "";
  const minutes = Math.round(deltaMs / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  const days = Math.round(hours / 24);
  if (days === 1) return "tomorrow";
  return `in ${days}d`;
}

export interface CalendarCountdownProps {
  /** ISO start timestamp of the event to count down to. */
  date: string;
  /**
   * Injected clock (epoch-ms) for deterministic tests/stories. Omitted in the
   * app so the leaf's own visibility-gated ticker drives it, this is the exact
   * prop shape the shared `<RelativeTime now?>` leaf (#14559) exposes, keeping
   * the swap trivial.
   */
  now?: number;
}

/**
 * Renders ONLY the relative-time text node. Because the ticker lives here (not
 * in the card), the minute tick re-renders this `<time>` alone, the card shell,
 * icon, title and grid tile stay put (§C.4 render-count lock).
 */
export function CalendarCountdown({
  date,
  now: injectedNow,
}: CalendarCountdownProps): JSX.Element {
  // Own clock: returns 0 on first render (deterministic) then ticks every minute
  // while visible. A caller-injected `now` wins for tests/stories.
  const tickNow = useVisibilityGatedNow(COUNTDOWN_TICK_MS);
  const now = injectedNow ?? tickNow;
  const label = now === 0 ? "" : formatCountdown(date, now);
  return (
    <time dateTime={date} suppressHydrationWarning>
      {label}
    </time>
  );
}
