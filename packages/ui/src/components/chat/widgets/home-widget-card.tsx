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
import { dispatchNavigateViewEvent } from "../../../events";
import { cn } from "../../../lib/utils";
import { useAppSelectorShallow } from "../../../state";
import { Button } from "../../ui/button";

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

// Every card sits on the ORANGE home wallpaper, and the brand maps the
// danger/warn/accent tokens to brand orange — so any `text-danger` /
// `bg-accent-subtle` here is orange-on-orange (the overdrawn amount and its
// badge rendered invisible). Tone must therefore use wallpaper-safe fixed
// colors: white text always; tone is carried by the icon dot + the badge chip.
const TONE_VALUE_CLASS: Record<HomeWidgetTone, string> = {
  default: "text-white",
  danger: "text-white",
  warn: "text-white",
};

const TONE_DOT_CLASS: Record<HomeWidgetTone, string> = {
  default: "bg-white/60",
  danger: "bg-white",
  warn: "bg-white/75",
};

// Dark glass chips read on the orange field (the token-tinted `bg-danger/15
// text-danger` chips did not — orange on orange). Danger/warn get the stronger
// fill so escalations still pop against the default count chips.
const TONE_BADGE_CLASS: Record<HomeWidgetTone, string> = {
  default: "bg-black/20 text-white/90",
  danger: "bg-black/35 text-white",
  warn: "bg-black/30 text-white",
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
    <Button
      variant="ghost"
      data-testid={testId}
      aria-label={ariaLabel}
      title={label}
      onClick={onActivate}
      className={cn(
        // Chromeless (#10708): no border/background/rounded card — content sits
        // directly on the wallpaper. Neutral-resting hover affordance is an
        // opacity change (no background fill), per the neutral hover rule.
        // `flex-wrap` + the value's min-width floor below keep the single datum
        // legible on half-width mobile cards: without them a wide shrink-0
        // badge ("Overdrawn") crushed the flex-1 value column to ~0px and the
        // currency vanished. When the row can't fit, the badge wraps under.
        "group h-auto w-full flex-wrap justify-start gap-3 whitespace-normal rounded-none bg-transparent px-3 py-2.5 text-left",
        "transition-opacity hover:bg-transparent hover:opacity-80",
      )}
    >
      <span
        className={cn(
          // Tonal glyph tints are skipped for the same orange-on-orange reason
          // as TONE_VALUE_CLASS: the escalated tones brighten to full white and
          // the corner dot marks the tone.
          "relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white/85 [&>svg]:h-4 [&>svg]:w-4",
          tone !== "default" && "text-white",
        )}
      >
        {icon}
        {tone !== "default" ? (
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-black/40",
              TONE_DOT_CLASS[tone],
            )}
          />
        ) : null}
      </span>

      {/* Icon-only: the lucide icon identifies the widget; the label is folded
          into the button's aria-label (and the hover title), never shown as a
          visible eyebrow. Only the single high-priority datum renders. */}
      <span className="flex min-w-[4.5rem] flex-1 flex-col">
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
        <span className="shrink-0 text-2xs tabular-nums text-white/60">
          {meta}
        </span>
      ) : null}
      {badge != null ? (
        <span
          className={cn(
            "shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-semibold",
            TONE_BADGE_CLASS[tone],
          )}
        >
          {badge}
        </span>
      ) : null}
    </Button>
  );
}
