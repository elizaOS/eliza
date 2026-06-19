import { Sparkles } from "lucide-react";
import * as React from "react";

import { useApp } from "../../../state";
import { startTutorial } from "./tutorial-controller";

/**
 * The tour launcher — the view the home "Tutorial" tile opens. Pressing Start
 * activates the global TutorialOverlay (the interactive tour) and drops the user
 * back on the home base so the tour can spotlight the real chat. Eliza narrates
 * each frame aloud; the tour can be muted from its card.
 */

const BRAND = "#FF5800";

export function TutorialView(): React.ReactElement {
  const { setTab } = useApp();

  const begin = React.useCallback(() => {
    startTutorial();
    setTab("chat"); // return home so the tour overlays the real chat
  }, [setTab]);

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center"
      data-testid="tutorial-launcher"
    >
      <div className="flex max-w-sm flex-col items-center">
        <div
          className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl"
          style={{
            backgroundColor: "rgba(255,88,0,0.14)",
            boxShadow: "0 0 28px 4px rgba(255,88,0,0.35)",
          }}
          aria-hidden
        >
          <Sparkles className="h-7 w-7" style={{ color: BRAND }} />
        </div>
        <h1 className="text-2xl font-semibold text-txt-strong">Quick tour</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-txt/70">
          A hands-on walkthrough of the basics — about a minute.
        </p>

        <button
          type="button"
          onClick={begin}
          data-testid="tutorial-start"
          className="mt-7 rounded-xl px-6 py-2.5 text-[15px] font-semibold text-white transition-colors"
          style={{ backgroundColor: BRAND }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "#D44A00";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = BRAND;
          }}
        >
          Start
        </button>
      </div>
    </div>
  );
}
