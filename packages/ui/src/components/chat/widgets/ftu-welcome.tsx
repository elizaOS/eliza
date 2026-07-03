/**
 * First-time-user welcome card (#9959).
 *
 * A fresh account lands on a near-empty home (clock + weather). This home-slot
 * widget fills that void with a guided welcome: a one-line greeting plus a few
 * tappable "try saying…" chips (the same model-backed suggestions the chat
 * composer offers, via {@link usePromptSuggestions}). It self-publishes the
 * `welcome` home-attention weight so it sits at the top for a cold user, yet
 * stays below approval/escalation/blocked once real activity exists, and it
 * RETIRES permanently — via the sunset lifecycle (home-dismissal-store) — once
 * the user taps a chip, sends a first message, or dismisses it. The retirement
 * persists across reloads.
 */

import { useEffect } from "react";
import { dispatchChatPrefill } from "../../../events";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import {
  dismissHomeWidget,
  markHomeWidgetActed,
  useRecordHomeWidgetSeen,
} from "../../../widgets/home-dismissal-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { usePromptSuggestions } from "../../shell/usePromptSuggestions";
import { Button } from "../../ui/button";

const PLUGIN_ID = "welcome";
const WIDGET_ID = "welcome.ftu";
const WIDGET_KEY = `${PLUGIN_ID}/${WIDGET_ID}`;
const DEFAULT_SPAN = "col-span-4 row-span-1";
const FIRST_USER_CHAT_EVENT_TYPES: ReadonlySet<string> = new Set([
  "message_received",
  "message_sent",
]);

function FtuWelcomeWidget({
  slot,
  events,
  spanClassName = DEFAULT_SPAN,
}: Partial<WidgetProps>): React.JSX.Element | null {
  const onHome = slot === "home";
  // Sit at the top of a cold home (below approval/escalation/blocked); the
  // sunset filter removes the card once it has retired, so this only publishes
  // while the card is genuinely live.
  usePublishHomeAttention(
    WIDGET_KEY,
    onHome ? HOME_SIGNAL_WEIGHTS.welcome : null,
  );
  useRecordHomeWidgetSeen(WIDGET_KEY, onHome);

  // The same suggestions the composer offers; cold (no thread) → starters /
  // model set. Three tappable chips.
  const suggestions = usePromptSuggestions([], { enabled: onHome });

  // Retire once a real chat turn starts. Some paths surface the first completed
  // turn as `message_received` without a preceding `message_sent` event.
  const sentAMessage = (events ?? []).some((event) =>
    FIRST_USER_CHAT_EVENT_TYPES.has(event.eventType),
  );
  useEffect(() => {
    if (onHome && sentAMessage) markHomeWidgetActed(WIDGET_KEY);
  }, [onHome, sentAMessage]);

  if (!onHome) return null;

  const onChip = (text: string) => {
    dispatchChatPrefill({ text, select: true });
    markHomeWidgetActed(WIDGET_KEY);
  };

  // Deliberately flat — no card/border/background/rounded-pill chrome. The
  // welcome sits directly on the home: a greeting line and the starters as plain
  // tappable text (hover underline is the only affordance).
  return (
    <section
      className={spanClassName}
      data-testid="chat-widget-ftu-welcome"
      aria-label="Welcome — getting started"
    >
      <p className="text-sm font-medium text-white">
        Welcome — ask me anything to get started.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-1.5">
        {suggestions.map((text) => (
          <Button
            key={text}
            data-testid="ftu-welcome-chip"
            onClick={() => onChip(text)}
            variant="ghost"
            size="sm"
            className="h-auto px-0 py-0 text-sm font-normal text-white/75 underline-offset-4 transition-colors hover:bg-transparent hover:text-white hover:underline"
          >
            {text}
          </Button>
        ))}
        <Button
          data-testid="ftu-welcome-dismiss"
          aria-label="Dismiss welcome"
          onClick={() => dismissHomeWidget(WIDGET_KEY)}
          variant="ghost"
          size="sm"
          className="h-auto px-0 py-0 text-sm font-normal text-white/60 transition-colors hover:bg-transparent hover:text-white/80"
        >
          Dismiss
        </Button>
      </div>
    </section>
  );
}

/** Home-slot registration descriptor (consumed by widgets/registry.ts). */
export const FTU_WELCOME_HOME_WIDGET = {
  pluginId: PLUGIN_ID,
  id: WIDGET_ID,
  // Low order = high base score, so on a cold home (no signals) the welcome card
  // ranks at the very top; real activity signals on other widgets outrank it.
  order: 20,
  signalKinds: ["welcome"],
  size: { cols: 4, rows: 1 } as const,
  // The defining lifecycle: gone the moment the user engages or dismisses.
  sunset: { afterAction: true, dismissible: true } as const,
  Component: FtuWelcomeWidget,
};
