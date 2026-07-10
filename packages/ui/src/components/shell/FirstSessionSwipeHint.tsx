/**
 * One-time first-session hint that teaches the home ↔ launcher swipe (#13453
 * design-verdict debt #5). The rail's page dots were removed (they collided
 * with the floating composer) and on touch devices the horizontal swipe is the
 * sole rail navigation, so a brand-new user has no signal the launcher exists.
 * This floating pill surfaces once — after a short settle delay in the user's
 * first session on the home half — then retires forever through the
 * home-dismissal sunset lifecycle: it counts one `seen` session when it
 * actually paints (`afterSeen: 1` retires it from the next session on),
 * retires on `acted` the moment the user first flips the rail to the launcher
 * (they demonstrably know the gesture — including before the hint ever shows),
 * and dismisses itself permanently after one full display cycle.
 *
 * Deliberately NOT persistent chrome: `pointer-events-none` + `aria-hidden`,
 * so it can never intercept the gesture it teaches, and it never renders on
 * fine-pointer/hover devices — {@link PagerEdgeButtons} is their resting
 * affordance (exact media-query complement, no gap and no overlap).
 */
import { ChevronLeft } from "lucide-react";
import * as React from "react";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/utils";
import type { HomeLauncherPage } from "../../state/shell-surface-store";
import {
  dismissHomeWidget,
  type HomeWidgetLifecycle,
  isHomeWidgetSunset,
  markHomeWidgetActed,
  recordHomeWidgetSeen,
  useHomeDismissals,
} from "../../widgets/home-dismissal-store";
import type { HomeWidgetSunset } from "../../widgets/types";
import { FINE_POINTER_EDGE_BUTTON_QUERY } from "./PagerEdgeButtons";
import {
  WALLPAPER_FLOAT_SHADOW,
  WALLPAPER_GLASS,
  WALLPAPER_TEXT,
} from "./wallpaper-idiom";

export const SWIPE_HINT_WIDGET_KEY = "shell:first-session-swipe-hint";

/**
 * Retire after the one session it painted in, immediately once the user
 * performs any rail navigation, or permanently after its own display cycle
 * completes (self-dismissed below). Whichever fires first wins.
 */
const SWIPE_HINT_SUNSET: HomeWidgetSunset = {
  afterSeen: 1,
  afterAction: true,
  dismissible: true,
};

/** Settle delay before the hint paints, so it never competes with home load. */
export const SWIPE_HINT_SHOW_DELAY_MS = 1600;
/** How long the hint stays up before fading itself out. */
export const SWIPE_HINT_DISPLAY_MS = 7000;
/** Fade-out duration; the permanent dismissal is recorded when it completes. */
export const SWIPE_HINT_FADE_MS = 600;

// Entrance slide-in plus a repeating leftward nudge on the chevron cluster —
// the nudge mimes the finger motion being taught. Fully stilled under
// prefers-reduced-motion (the pill still shows; only the motion stops).
const SWIPE_HINT_CSS = `
@keyframes swipe-hint-in {
  from { opacity: 0; transform: translateX(10px); }
  to   { opacity: 1; transform: none; }
}
@keyframes swipe-hint-nudge {
  0%, 55%, 100% { transform: translateX(0); }
  25% { transform: translateX(-6px); }
}
.swipe-hint-pill { animation: swipe-hint-in 420ms cubic-bezier(0.22,1,0.36,1) both; }
.swipe-hint-chevrons { animation: swipe-hint-nudge 1.8s ease-in-out 600ms 3; }
@media (prefers-reduced-motion: reduce) {
  .swipe-hint-pill, .swipe-hint-chevrons { animation: none; }
}
`;

/**
 * Whether the hint may still start its one showing. The sunset policy is
 * evaluated against the lifecycle as it will be AFTER this session's `seen`
 * is counted, so a first showing interrupted mid-display (reload, closed tab)
 * can never earn a second one — "one-time" is one reveal ever, not one
 * completed display.
 */
function canStartShowing(life: HomeWidgetLifecycle): boolean {
  const predicted: HomeWidgetLifecycle = { ...life, seen: life.seen + 1 };
  return !isHomeWidgetSunset(SWIPE_HINT_WIDGET_KEY, SWIPE_HINT_SUNSET, {
    [SWIPE_HINT_WIDGET_KEY]: predicted,
  });
}

export function FirstSessionSwipeHint({
  page,
}: {
  page: HomeLauncherPage;
}): React.JSX.Element | null {
  const finePointer = useMediaQuery(FINE_POINTER_EDGE_BUTTON_QUERY);
  const dismissals = useHomeDismissals();
  const lifecycle = dismissals[SWIPE_HINT_WIDGET_KEY];
  const seen = lifecycle?.seen ?? 0;
  // The user has proven (or ended) the lesson. The reveal-time `seen` bump can
  // retire the hint under its afterSeen policy mid-display — that must not
  // yank a pill that is already up, so only acted/dismissed hide it live.
  const acted = lifecycle?.acted === true || lifecycle?.dismissed === true;

  const [shown, setShown] = React.useState(false);
  const [fading, setFading] = React.useState(false);
  const [done, setDone] = React.useState(false);

  // Any home → launcher flip (swipe, edge button, tutorial) demonstrates the
  // rail; retire the hint permanently even if it never painted. Route-driven
  // initial pages don't count: only an observed home → launcher transition.
  const prevPageRef = React.useRef<HomeLauncherPage | null>(null);
  React.useEffect(() => {
    const prev = prevPageRef.current;
    prevPageRef.current = page;
    if (prev === "home" && page === "launcher") {
      markHomeWidgetActed(SWIPE_HINT_WIDGET_KEY);
    }
  }, [page]);

  // Reveal: eligibility is evaluated when the settle delay elapses, and the
  // `seen` session is only counted when the hint actually paints — a session
  // spent entirely on the launcher half never consumes the one showing.
  // Primitive deps keep unrelated dismissal-store churn (other widgets
  // recording their own lifecycles) from restarting the delay.
  React.useEffect(() => {
    if (shown || done || acted || finePointer || page !== "home") return;
    if (!canStartShowing({ seen, acted: false, dismissed: false })) return;
    const timer = window.setTimeout(() => {
      setShown(true);
      recordHomeWidgetSeen(SWIPE_HINT_WIDGET_KEY);
    }, SWIPE_HINT_SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [shown, done, acted, seen, finePointer, page]);

  React.useEffect(() => {
    if (!shown || fading || done) return;
    const timer = window.setTimeout(
      () => setFading(true),
      SWIPE_HINT_DISPLAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [shown, fading, done]);

  // The display cycle completing IS the permanent dismissal — "one-time" is
  // literal: one full showing, then never again, even across remounts within
  // the same session.
  React.useEffect(() => {
    if (!fading || done) return;
    const timer = window.setTimeout(() => {
      setDone(true);
      dismissHomeWidget(SWIPE_HINT_WIDGET_KEY);
    }, SWIPE_HINT_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [fading, done]);

  if (!shown || done || acted || page !== "home") return null;

  return (
    <div
      data-testid="first-session-swipe-hint"
      aria-hidden
      className={cn(
        "pointer-events-none absolute right-4 top-1/2 z-10 -translate-y-1/2 transition-opacity",
        fading ? "opacity-0" : "opacity-100",
      )}
      style={{ transitionDuration: `${SWIPE_HINT_FADE_MS}ms` }}
    >
      <style>{SWIPE_HINT_CSS}</style>
      <div
        className={cn(
          "swipe-hint-pill flex items-center gap-2 rounded-full py-2 pr-3.5 pl-2.5",
          WALLPAPER_GLASS.floatingControl,
        )}
      >
        <span className="swipe-hint-chevrons flex items-center">
          <ChevronLeft className="-mr-2 h-4 w-4 opacity-40" aria-hidden />
          <ChevronLeft className="-mr-2 h-4 w-4 opacity-70" aria-hidden />
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </span>
        <span
          className={cn(
            "text-xs font-medium",
            WALLPAPER_TEXT.strong,
            WALLPAPER_FLOAT_SHADOW,
          )}
        >
          Swipe for apps
        </span>
      </div>
    </div>
  );
}
