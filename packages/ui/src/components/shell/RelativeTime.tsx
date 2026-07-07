/**
 * `<RelativeTime>` - the leaf of the binding pattern (spec §C.4).
 *
 * A relative timestamp ("5m ago") has to refresh as time passes, but nothing
 * *around* it does. The old shape put a `useNow(60s)` at the top of
 * `NotificationsHomeCenter`, so the whole inbox (up to 100 rows, each with
 * buttons, over a blurred glass surface) re-rendered every minute just to move
 * a few text nodes. This leaf inverts that: it is the ONLY thing subscribed to
 * the minute tick, so the tick re-renders the `<time>` text node and nothing
 * else. Its parent row can then be `React.memo`'d on stable props.
 *
 * It reads the single, module-level, visibility-gated ticker (`useSharedNow`),
 * so N leaves on screen share ONE interval that pauses while the tab is hidden.
 *
 * Render-path determinism: `useSharedNow` returns `0` on the first render (no
 * `Date.now()` in render - the UI determinism convention). At the epoch we
 * still render a correct string because `formatRelativeTime` reads the wall
 * clock itself; the `now` subscription exists purely to trigger the re-render
 * when the minute rolls over. We depend on `now` (via the `key`-free re-render)
 * so the lint/compile can't see it as unused - it is the tick signal.
 */

import { memo } from "react";
import { useSharedNow } from "../../hooks/useSharedNow";
import {
  formatRelativeTime,
  formatRelativeTimeShort,
} from "../../utils/format";

type RelativeTimeTranslator = (
  key: string,
  vars?: Record<string, string | number | boolean | null | undefined>,
) => string;

export interface RelativeTimeProps {
  /** The timestamp to render relative to now (epoch-ms, ISO string, or Date). */
  ts: string | number | Date;
  /** Optional i18n translator forwarded to `formatRelativeTime`. */
  t?: RelativeTimeTranslator;
  /** Compact form: bare `5m` / `3h` / `2d`, no "ago" suffix, "now" under 1m. */
  short?: boolean;
  /** Extra classes for the `<time>` element. */
  className?: string;
  /** Test hook / a11y hook passthrough. */
  "data-testid"?: string;
}

/**
 * The relative-time text node. Subscribes to the shared minute ticker so it
 * (and only it) re-renders when the minute rolls over; the formatted string is
 * derived from the wall clock at render time.
 *
 * Memoized on `(ts, className, testid)`: a parent re-render with the same props
 * does not re-render the leaf, and a tick re-renders the leaf without touching
 * the parent - the two directions of the binding pattern.
 */
function RelativeTimeImpl({
  ts,
  t,
  short,
  className,
  "data-testid": testId,
}: RelativeTimeProps): React.JSX.Element {
  // Subscribe to the shared ticker purely for the re-render signal. The value
  // is intentionally not read into the label - `formatRelativeTime` reads the
  // clock itself - but subscribing is what makes the minute roll re-render this
  // node (and nothing above it). `void` marks it as an intentional tick sink.
  void useSharedNow();

  const date = ts instanceof Date ? ts : new Date(ts);
  const iso = Number.isFinite(date.getTime()) ? date.toISOString() : undefined;

  return (
    <time className={className} dateTime={iso} data-testid={testId}>
      {short ? formatRelativeTimeShort(ts) : formatRelativeTime(ts, t)}
    </time>
  );
}

/**
 * `React.memo` so a parent (row) re-render with unchanged props is a no-op for
 * the leaf. `t` is compared by reference - callers should pass a stable
 * translator (the i18n `t` is stable per render tree); an inline `t` would
 * defeat the memo but callers on the home surface pass none.
 */
export const RelativeTime = memo(RelativeTimeImpl);
RelativeTime.displayName = "RelativeTime";
