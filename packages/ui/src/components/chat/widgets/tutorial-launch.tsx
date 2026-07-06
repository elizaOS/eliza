/**
 * Home-slot launcher for the chat-native onboarding tour.
 *
 * The card starts or restarts the tutorial service and opens chat, where the
 * seeded tour turns appear. It publishes the `welcome` home-attention weight
 * while visible and uses the sunset lifecycle so launch/dismiss retire it
 * permanently across reloads.
 */

import { GraduationCap } from "lucide-react";
import type { JSX } from "react";
import { dispatchChatOpen } from "../../../events";
import {
  restartTutorial,
  startTutorial,
  useTutorial,
} from "../../../tutorial/tutorial-service";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import {
  dismissHomeWidget,
  markHomeWidgetActed,
  useRecordHomeWidgetSeen,
} from "../../../widgets/home-dismissal-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { Button } from "../../ui/button";

const PLUGIN_ID = "tutorial";
const WIDGET_ID = "tutorial.launch";
const WIDGET_KEY = `${PLUGIN_ID}/${WIDGET_ID}`;
const DEFAULT_SPAN = "col-span-4 row-span-1";

function TutorialLaunchWidget({
  slot,
  spanClassName = DEFAULT_SPAN,
}: Partial<WidgetProps>): JSX.Element | null {
  const onHome = slot === "home";
  const { status } = useTutorial();

  // Sit near the top of a cold home (below approval/escalation/blocked); the
  // sunset filter removes the card once it has retired, so this only publishes
  // while the card is genuinely live.
  usePublishHomeAttention(
    WIDGET_KEY,
    onHome ? HOME_SIGNAL_WEIGHTS.welcome : null,
  );
  useRecordHomeWidgetSeen(WIDGET_KEY, onHome);

  if (!onHome) return null;

  const launch = () => {
    // Restart a finished/stopped tour from the top; a fresh idle run just
    // starts. Either way, open the chat where the seeded turns appear.
    if (status === "active") startTutorial();
    else restartTutorial();
    dispatchChatOpen();
    markHomeWidgetActed(WIDGET_KEY);
  };

  const label = status === "active" ? "Reopen the tour" : "Take a quick tour";

  // Deliberately flat, matching the FTU welcome card: an editorial line plus a
  // warm-tinted tappable action and a quiet dismiss — no card chrome.
  return (
    <section
      className={spanClassName}
      data-testid="chat-widget-tutorial-launch"
      aria-label="Take a tour"
    >
      <p className="flex items-center gap-2 text-sm font-medium leading-snug text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.4)]">
        <GraduationCap className="h-4 w-4 text-accent" aria-hidden />
        New here? A one-minute tour runs right in the chat.
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        <Button
          data-testid="tutorial-launch-start"
          onClick={launch}
          variant="ghost"
          size="sm"
          className="h-auto rounded-full border border-accent/25 bg-accent-subtle px-3 py-1.5 text-xs font-medium text-white transition-colors duration-150 hover:border-accent/45 hover:bg-accent/20 active:scale-[0.97] motion-reduce:active:scale-100"
        >
          {label}
        </Button>
        <Button
          data-testid="tutorial-launch-dismiss"
          aria-label="Dismiss tour prompt"
          onClick={() => dismissHomeWidget(WIDGET_KEY)}
          variant="ghost"
          size="sm"
          className="h-auto px-1 py-0 text-xs text-white/60 transition-colors hover:bg-transparent hover:text-white"
        >
          Dismiss
        </Button>
      </div>
    </section>
  );
}

/** Home-slot registration descriptor (consumed by widgets/registry.ts). */
export const TUTORIAL_LAUNCH_HOME_WIDGET = {
  pluginId: PLUGIN_ID,
  id: WIDGET_ID,
  // Just above the FTU welcome's base order so a cold home shows the welcome
  // greeting first, then the tour offer directly beneath it; real activity
  // signals on other widgets outrank both.
  order: 21,
  signalKinds: ["welcome"],
  size: { cols: 4, rows: 1 } as const,
  // Retire immediately after a deliberate launch or dismiss so onboarding
  // prompts never become recurring home clutter.
  sunset: { afterAction: true, dismissible: true } as const,
  Component: TutorialLaunchWidget,
};
