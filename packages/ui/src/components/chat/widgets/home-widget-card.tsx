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

// The datum tone. Default is high-contrast white on the warm-dark card; danger/
// warn carry the accent so an at-risk widget reads at a glance.
const TONE_VALUE_CLASS: Record<HomeWidgetTone, string> = {
  default: "text-white",
  danger: "text-danger",
  warn: "text-warn",
};

// The icon chip tone: a warm-tinted resting chip, escalating to the status hue.
const TONE_CHIP_CLASS: Record<HomeWidgetTone, string> = {
  default: "bg-[rgba(255,106,31,0.12)] text-[#ffb488]",
  danger: "bg-danger/15 text-danger",
  warn: "bg-warn/15 text-warn",
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
        // A SOLID warm-dark tile (var(--surface-1)) with a warm hairline edge,
        // so it sits in the ember field instead of letting it bleed through
        // (the old bg-black/55 was translucent). A left accent rail keys the
        // tone. Tactile: a hair lift + warmer edge on hover, scale-press on tap.
        "group relative flex w-full items-center gap-3 overflow-hidden rounded-2xl border border-white/[0.07] bg-[var(--surface-1)] px-3.5 py-3 text-left",
        "transition-[transform,border-color,background-color] duration-150",
        "hover:border-[rgba(255,106,31,0.28)] hover:bg-[var(--surface-2)]",
        "active:scale-[0.985] motion-reduce:active:scale-100",
      )}
    >
      {/* Left accent rail: a quiet ember stripe at rest, brightening on hover,
          a deliberate edge detail, not a generic one-sided border. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-y-2.5 left-0 w-[3px] rounded-full transition-colors duration-150",
          tone === "danger"
            ? "bg-danger/70"
            : tone === "warn"
              ? "bg-warn/70"
              : "bg-[rgba(255,106,31,0.35)] group-hover:bg-[rgba(255,106,31,0.7)]",
        )}
      />
      <span
        className={cn(
          "relative inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl [&>svg]:h-[18px] [&>svg]:w-[18px]",
          TONE_CHIP_CLASS[tone],
        )}
      >
        {icon}
        {tone !== "default" ? (
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-[#1d130c]",
              TONE_DOT_CLASS[tone],
            )}
          />
        ) : null}
      </span>

      {/* The label is now a visible eyebrow (the widgets are the hero, so they
          read as a real dashboard), with the single high-priority datum below
          it. When a widget supplies no datum, the label carries the row alone. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[0.6875rem] font-medium uppercase tracking-[0.08em] text-white/45">
          {label}
        </span>
        {value != null ? (
          <span
            className={cn(
              "truncate text-[0.9375rem] font-semibold leading-tight",
              TONE_VALUE_CLASS[tone],
            )}
          >
            {value}
          </span>
        ) : null}
      </span>

      {meta != null ? (
        <span className="shrink-0 text-[0.6875rem] tabular-nums text-white/55">
          {meta}
        </span>
      ) : null}
      {badge != null ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold tabular-nums",
            tone === "danger"
              ? "bg-danger/15 text-danger"
              : tone === "warn"
                ? "bg-warn/15 text-warn"
                : "bg-[rgba(255,106,31,0.16)] text-[#ffb488]",
          )}
        >
          {badge}
        </span>
      ) : null}
    </button>
  );
}
