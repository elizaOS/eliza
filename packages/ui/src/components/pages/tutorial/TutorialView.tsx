import * as React from "react";

import { useApp } from "../../../state";
import { startTutorial } from "./tutorial-controller";
import { TUTORIAL_STEPS } from "./tutorial-steps";

/**
 * The Tutorial launcher — the view the home "Tutorial" tile opens. It's a warm
 * intro screen; pressing a Start button activates the global TutorialOverlay (the
 * actual interactive tour) and drops the user back on the home base so the tour
 * can spotlight the real chat + tiles. Text and voice are two ways to take the
 * SAME tour (voice narrates each step aloud); both are one tap.
 */

const BRAND = "#FF5800";

export function TutorialView(): React.ReactElement {
  const { setTab } = useApp();

  const begin = React.useCallback(
    (mode: "text" | "voice") => {
      startTutorial(mode);
      // Return to the home base so the tour overlays the real app (chat + tiles).
      setTab("chat");
    },
    [setTab],
  );

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center"
      data-testid="tutorial-launcher"
    >
      <div className="flex max-w-md flex-col items-center">
        <div
          className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl text-3xl"
          style={{
            backgroundColor: "rgba(255,88,0,0.14)",
            boxShadow: `0 0 28px 4px rgba(255,88,0,0.35)`,
          }}
          aria-hidden
        >
          ✨
        </div>
        <h1 className="text-2xl font-semibold text-txt-strong">
          Learn Eliza in 90 seconds
        </h1>
        <p className="mt-2 text-[15px] leading-relaxed text-txt/70">
          A quick, hands-on tour. Glowing pointers show you exactly what to tap;
          Eliza checks each step as you go. You'll learn to open, expand and
          shrink the chat, switch screens just by asking, and find Settings.
        </p>

        <div className="mt-7 flex w-full flex-col gap-2.5 sm:flex-row sm:justify-center">
          <button
            type="button"
            onClick={() => begin("text")}
            data-testid="tutorial-start-text"
            className="rounded-xl px-5 py-2.5 text-[15px] font-semibold text-white transition-colors"
            style={{ backgroundColor: BRAND }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "#D44A00";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = BRAND;
            }}
          >
            Start the tour
          </button>
          <button
            type="button"
            onClick={() => begin("voice")}
            data-testid="tutorial-start-voice"
            className="rounded-xl border border-white/15 px-5 py-2.5 text-[15px] font-semibold text-txt-strong transition-colors hover:bg-white/8"
          >
            🔊 Start with voice
          </button>
        </div>

        <p className="mt-4 text-[12px] text-txt/45">
          {TUTORIAL_STEPS.length} short steps · you can skip any time · re-run
          it whenever you like
        </p>
      </div>
    </div>
  );
}
