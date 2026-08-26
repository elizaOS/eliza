/**
 * HomeWidgetCard - the compact, icon-first, whole-card-clickable building block
 * for the home dashboard (#9143).
 *
 * Home widgets are glanceable, not dashboards: an icon, a one-word label, and a
 * SINGLE high-priority datum (a value and/or a status badge). The whole card is
 * a button - tapping it navigates to the full surface (or runs the relevant
 * action). Because the visible text is intentionally minimal, the full meaning
 * lives in `ariaLabel` for screen readers.
 *
 * Sits on the orange home wallpaper as a solid brand-token tile. Home glass
 * belongs to the notification center recipe only; resident cards do not add
 * blur or translucent black layers. Orange is accent-only: resting neutral,
 * escalating to the status hue on danger/warn. All color comes from tokens so
 * the tile stays theme-aware.
 */

import { type ReactNode, useMemo } from "react";
import { reportUserViewSwitch } from "../../../chat/useSlashCommandController";
import { dispatchNavigateViewEvent } from "../../../events";
import { cn } from "../../../lib/utils";
import { useAppSelectorShallow } from "../../../state";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { StatusDot } from "../../ui/status-badge";

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
        dispatchNavigateViewEvent({ viewPath: path });
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

export const HOME_WIDGET_SOLID_TILE_CLASS =
  "group relative flex h-auto w-full overflow-hidden rounded-2xl border border-[color:color-mix(in_srgb,var(--brand-white)_20%,var(--brand-black))] bg-[var(--brand-black)] text-left text-[var(--brand-white)]";

const TONE_VALUE_CLASS: Record<HomeWidgetTone, string> = {
  default: "text-[var(--brand-white)]",
  danger: "text-[var(--brand-white)]",
  warn: "text-[var(--brand-white)]",
};

export interface HomeWidgetCardProps {
  /** Lucide icon (the primary identifier - text is secondary). */
  icon: ReactNode;
  /** One short label, e.g. "Bills", "Goals", "Sleep". */
  label: string;
  /** The single high-priority datum, e.g. "−$125.50" or "Design review". */
  value?: ReactNode;
  /** Secondary metric kept tight, e.g. "in 45m" - omit when not high-signal. */
  meta?: ReactNode;
  /** Count/status pill, e.g. "1", "At risk", "Irregular". */
  badge?: ReactNode;
  tone?: HomeWidgetTone;
  /** data-testid on the card button. */
  testId: string;
  /** Full accessible description - visible text is minimal, so this carries it. */
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
    <Button
      variant="surface"
      size="card"
      align="start"
      data-testid={testId}
      aria-label={ariaLabel}
      title={label}
      onClick={onActivate}
    >
      {/* Left accent rail: a quiet ember stripe at rest, brightening on hover,
          a deliberate edge detail, not a generic one-sided border. */}
      <StatusDot
        aria-hidden
        tone={
          tone === "danger" ? "danger" : tone === "warn" ? "warning" : "accent"
        }
        className="absolute inset-y-2.5 left-0 h-auto w-[3px] transition-colors duration-150"
      />
      <Badge
        asChild
        variant={
          tone === "danger"
            ? "statusDanger"
            : tone === "warn"
              ? "statusWarning"
              : "statusMuted"
        }
        size="providerMark"
      >
        <span className="relative size-9 shrink-0 [&>svg]:size-4.5">
          {icon}
        </span>
      </Badge>

      {/* The label is now a visible eyebrow (the widgets are the hero, so they
          read as a real dashboard), with the single high-priority datum below
          it. When a widget supplies no datum, the label carries the row alone. */}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-xs-tight font-medium uppercase tracking-wider text-[color:color-mix(in_srgb,var(--brand-white)_68%,transparent)]">
          {label}
        </span>
        {value != null ? (
          <span
            className={cn(
              // Wrap to two lines before ellipsizing: half-width mobile cards
              // (col-span-2 at 390px) hard-clipped one-line values to a few
              // characters ("Confirm…", "Paymen…"), which read broken. Two
              // lines keeps the datum glanceable without unbounded growth.
              "line-clamp-2 break-words text-sm font-semibold leading-tight",
              TONE_VALUE_CLASS[tone],
            )}
          >
            {value}
          </span>
        ) : null}
      </span>

      {meta != null ? (
        <span className="shrink-0 text-xs-tight tabular-nums text-[color:color-mix(in_srgb,var(--brand-white)_82%,transparent)]">
          {meta}
        </span>
      ) : null}
      {badge != null ? (
        <Badge
          asChild
          variant={
            tone === "danger"
              ? "statusDanger"
              : tone === "warn"
                ? "statusWarning"
                : "statusMuted"
          }
          size="pill"
        >
          <span className="shrink-0 text-xs-tight font-semibold tabular-nums">
            {badge}
          </span>
        </Badge>
      ) : null}
    </Button>
  );
}
