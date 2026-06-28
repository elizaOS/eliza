import { Sparkles } from "lucide-react";
import * as React from "react";

import { useAgentElement } from "../../../agent-surface";
import { useAppSelector } from "../../../state";
import { Button } from "../../ui/button";
import { ShellViewAgentSurface } from "../../views/ShellViewAgentSurface";
import { startTutorial } from "./tutorial-controller";

/**
 * The tour launcher — the view the home "Tutorial" tile opens. Pressing Start
 * activates the global TutorialOverlay (the interactive tour) and drops the user
 * back on the home base so the tour can spotlight the real chat. Eliza narrates
 * each frame aloud; the tour can be muted from its card.
 */

export function TutorialView(): React.ReactElement {
  return (
    <ShellViewAgentSurface viewId="tutorial">
      <TutorialViewBody />
    </ShellViewAgentSurface>
  );
}

function TutorialViewBody(): React.ReactElement {
  const setTab = useAppSelector((s) => s.setTab);

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
      className="flex h-full w-full flex-col items-center justify-center overflow-y-auto px-6 py-6 text-center"
      data-testid="tutorial-launcher"
    >
      <div className="flex max-w-xs flex-col items-center">
        <Sparkles className="mb-3 h-7 w-7 text-accent" aria-hidden />
        <p className="text-xs text-txt/60">About a minute</p>

        <Button
          ref={start.ref}
          {...start.agentProps}
          onClick={begin}
          data-testid="tutorial-start"
          size="lg"
          className="mt-4 text-[15px] font-semibold"
        >
          Start
        </Button>
      </div>
    </div>
  );
}
