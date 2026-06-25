/**
 * HomeWidgetCard — the compact, icon-first, whole-card-clickable building block
 * for the home dashboard (#9143).
 *
 * Home widgets are glanceable, not dashboards: an icon, a one-word label, and a
 * SINGLE high-priority datum (a value and/or a status badge). The whole card is
 * a button — tapping it navigates to the full surface (or runs the relevant
 * action). Because the visible text is intentionally minimal, the full meaning
 * lives in `ariaLabel` for screen readers.
 *
 * Sits on the orange home wallpaper, so it's a translucent neutral glass tile
 * (orange is accent-only; resting neutral → neutral-with-opacity hover, never
 * orange→black — per the hover system).
 */

import { type ReactNode, useMemo } from "react";
import { reportUserViewSwitch } from "../../../chat/useSlashCommandController";
import { cn } from "../../../lib/utils";
import { useAppSelectorShallow } from "../../../state";

/**
 * Navigation for home widgets: tapping a card opens the relevant full surface.
 * `openView` mirrors the home tile path (the `eliza:navigate:view` rail +
 * proactive-decider report), `openTab` switches a builtin tab. Stable across
 * renders so it never breaks a widget's memoization.
 */
export function useWidgetNavigation(): {
  openView: (path: string, viewId?: string) => void;
  openTab: (tab: string) => void;
} {
  const { setTab } = useAppSelectorShallow((s) => ({ setTab: s.setTab }));
  return useMemo(
    () => ({
      openView(path, viewId) {
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("eliza:navigate:view", {
              detail: { viewPath: path },
            }),
          );
        }
        reportUserViewSwitch(viewId ?? path, path);
      },
      openTab(tab) {
        setTab?.(tab as never);
        reportUserViewSwitch(tab);
      },
    }),
    [setTab],
  );
}

export type HomeWidgetTone = "default" | "danger" | "warn";

// White by default: the card sits on the bright orange home wallpaper, so the
// datum must be near-white for legibility (theme `text-txt` washed out to a
// low-contrast dark on orange — a WCAG-AA failure). Danger/warn keep their
// semantic hues, which read clearly on the dark-glass tile.
const TONE_VALUE_CLASS: Record<HomeWidgetTone, string> = {
  default: "text-white",
  danger: "text-danger",
  warn: "text-warn",
};

const TONE_DOT_CLASS: Record<HomeWidgetTone, string> = {
  default: "bg-muted",
  danger: "bg-danger",
  warn: "bg-warn",
};

export interface HomeWidgetCardProps {
  /** Lucide icon (the primary identifier — text is secondary). */
  icon: ReactNode;
  /** One short label, e.g. "Bills", "Goals", "Sleep". */
  label: string;
  /** The single high-priority datum, e.g. "−$125.50" or "Design review". */
  value?: ReactNode;
  /** Secondary metric kept tight, e.g. "in 45m" — omit when not high-signal. */
  meta?: ReactNode;
  /** Count/status pill, e.g. "1", "At risk", "Irregular". */
  badge?: ReactNode;
  tone?: HomeWidgetTone;
  /** data-testid on the card button. */
  testId: string;
  /** Full accessible description — visible text is minimal, so this carries it. */
  ariaLabel: string;
  /** Tap / Enter → navigate to the full surface or run the action. */
  onActivate: () => void;
}

export function HomeWidgetCard({
  icon,
  label,
  value,
  meta,
  badge,
  tone = "default",
  testId,
  ariaLabel,
  onActivate,
}: HomeWidgetCardProps): React.JSX.Element {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={ariaLabel}
      title={label}
      onClick={onActivate}
      className={cn(
        // Dark translucent glass on the orange home wallpaper (theme-independent,
        // matching the OS tiles / springboard icons) so white text reads and the
        // card lifts off the orange field with real figure/ground. Neutral
        // resting → neutral-with-opacity hover (never orange→black), per the
        // hover system.
        // A clearly DARK neutral glass (not a light orange-tint) is required so
        // BOTH white default values AND the brand-orange danger/warn values
        // (--danger/--warn are brand orange) read with contrast — orange text
        // only pops on a dark, mostly-neutral surface, not on an orange wash.
        "group flex w-full items-center gap-3 rounded-xl border border-white/12 bg-black/45 px-3 py-2.5 text-left backdrop-blur-md",
        "transition-colors hover:bg-black/55",
      )}
    >
      <span
        className={cn(
          "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white/85 [&>svg]:h-4 [&>svg]:w-4",
          tone === "danger" && "text-danger",
          tone === "warn" && "text-warn",
        )}
      >
        {icon}
        {tone !== "default" ? (
          <span
            aria-hidden
            className={cn(
              // A clearly FILLED status dot (a thin ring just separates it from
              // the icon). The old h-2 + border-2 left the border dominating the
              // dot so it read as a hollow ring / artifact on every toned card.
              "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-black/40",
              TONE_DOT_CLASS[tone],
            )}
          />
        ) : null}
      </span>

      {/* Icon-only: the lucide icon identifies the widget; the label is folded
          into the button's aria-label (and the hover title), never shown as a
          visible eyebrow. Only the single high-priority datum renders. */}
      <span className="flex min-w-0 flex-1 flex-col">
        {value != null ? (
          <span
            className={cn(
              "truncate text-sm font-semibold leading-tight",
              TONE_VALUE_CLASS[tone],
            )}
          >
            {value}
          </span>
        ) : null}
      </span>

      {meta != null ? (
        <span className="shrink-0 text-2xs tabular-nums text-white/60">
          {meta}
        </span>
      ) : null}
      {badge != null ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-semibold",
            tone === "danger"
              ? "bg-danger/15 text-danger"
              : tone === "warn"
                ? "bg-warn/15 text-warn"
                : "bg-accent-subtle text-accent",
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}
