import * as React from "react";

import { useApp } from "../../../state";
import { startTutorial } from "./tutorial-controller";

/**
 * The `/tutorial` route is a pure launcher — it has no UI of its own. It kicks
 * off the global TutorialOverlay (whose first "welcome" step IS the single
 * intro / "Start the tour" gate) and drops the user back on the home base so
 * the tour can spotlight the real chat + tiles.
 *
 * There used to be a separate splash screen here with its own "Start the tour"
 * button, which then handed off to the overlay's "Start the tour" welcome card —
 * a duplicative double-start. The overlay's welcome step is the one source of
 * truth, shared by every entry point (this route, the home tile, first-run
 * auto-launch, and Help deep-links).
 */
export function TutorialView(): React.ReactElement {
  const { setTab } = useApp();
  const launchedRef = React.useRef(false);

  React.useEffect(() => {
    if (launchedRef.current) return;
    launchedRef.current = true;
    startTutorial();
    // Return to the home base so the tour overlays the real app (chat + tiles).
    setTab("chat");
  }, [setTab]);

  return <div data-testid="tutorial-launcher" className="h-full w-full" />;
}
