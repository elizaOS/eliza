import { Sparkles } from "lucide-react";
import * as React from "react";

import { useAgentElement } from "../../../agent-surface";
import { useApp } from "../../../state";
import { Button } from "../../ui/button";
import { startTutorial } from "./tutorial-controller";

/**
 * The tour launcher — the view the home "Tutorial" tile opens. Pressing Start
 * activates the global TutorialOverlay (the interactive tour) and drops the user
 * back on the home base so the tour can spotlight the real chat. Eliza narrates
 * each frame aloud; the tour can be muted from its card.
 */

export function TutorialView(): React.ReactElement {
  const { setTab } = useApp();

  const begin = React.useCallback(() => {
    startTutorial();
    setTab("chat"); // return home so the tour overlays the real chat
  }, [setTab]);

  const start = useAgentElement<HTMLButtonElement>({
    id: "tutorial-start",
    role: "button",
    label: "Start quick tour",
    description: "Launch the interactive walkthrough of the basics",
    onActivate: begin,
  });

  return (
    <div
      className="flex h-full w-full flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center"
      data-testid="tutorial-launcher"
    >
      <div className="flex max-w-sm flex-col items-center">
        <div
          className="mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-accent-subtle"
          style={{
            boxShadow:
              "0 0 28px 4px color-mix(in srgb, var(--accent) 35%, transparent)",
          }}
          aria-hidden
        >
          <Sparkles className="h-7 w-7 text-accent" />
        </div>
        <h1 className="text-2xl font-semibold text-txt-strong">Quick tour</h1>
        <p className="mt-2 text-[15px] leading-relaxed text-txt/70">
          A hands-on walkthrough of the basics — about a minute.
        </p>

        <Button
          ref={start.ref}
          {...start.agentProps}
          onClick={begin}
          data-testid="tutorial-start"
          size="lg"
          className="mt-7 text-[15px] font-semibold"
        >
          Start
        </Button>
      </div>
    </div>
  );
}
