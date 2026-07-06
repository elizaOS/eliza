import { X } from "lucide-react";
import type * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import {
  dismissHomeWidget,
  isHomeWidgetSunset,
  recordHomeWidgetSeen,
  useHomeDismissals,
} from "../../widgets/home-dismissal-store";
import type { HomeWidgetSunset } from "../../widgets/types";

export const HOME_GESTURE_HINT_KEY = "shell/home-gesture-hint";

const GESTURE_HINT_SUNSET = {
  dismissible: true,
  afterSeen: 1,
} satisfies HomeWidgetSunset;

export function HomeGestureHint(): React.JSX.Element | null {
  const dismissals = useHomeDismissals();
  const lifecycle = dismissals[HOME_GESTURE_HINT_KEY];
  const [recordedThisMount, setRecordedThisMount] = useState(false);

  const hidden = useMemo(() => {
    if (
      isHomeWidgetSunset(HOME_GESTURE_HINT_KEY, GESTURE_HINT_SUNSET, dismissals)
    ) {
      return true;
    }
    return (lifecycle?.seen ?? 0) >= 1 && !recordedThisMount;
  }, [dismissals, lifecycle?.seen, recordedThisMount]);

  useEffect(() => {
    if (hidden || recordedThisMount) return;
    recordHomeWidgetSeen(HOME_GESTURE_HINT_KEY);
    setRecordedThisMount(true);
  }, [hidden, recordedThisMount]);

  if (hidden) return null;

  return (
    <div
      data-testid="home-gesture-hint"
      className={cn(
        "mx-auto w-fit max-w-full rounded-full border border-white/25 bg-card/90 px-3 py-2 text-card-foreground shadow-lg shadow-black/10",
        "transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none",
      )}
    >
      <div className="flex items-center gap-2 text-[0.8125rem] font-medium leading-tight">
        <span className="text-muted-foreground">
          Swipe for apps. Pull chat up. Hold wallpaper to restyle.
        </span>
        <button
          type="button"
          aria-label="Dismiss gesture hint"
          className={cn(
            "-my-2 -mr-2 grid h-11 w-11 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
            "active:scale-[0.96] motion-reduce:active:scale-100",
          )}
          onClick={() => dismissHomeWidget(HOME_GESTURE_HINT_KEY)}
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  );
}
