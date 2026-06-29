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

import { X } from "lucide-react";
import { useEffect } from "react";
import { dispatchChatPrefill } from "../../../events";
import { cn } from "../../../lib/utils";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import {
  dismissHomeWidget,
  markHomeWidgetActed,
  useRecordHomeWidgetSeen,
} from "../../../widgets/home-dismissal-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { usePromptSuggestions } from "../../shell/usePromptSuggestions";

const PLUGIN_ID = "welcome";
const WIDGET_ID = "welcome.ftu";
const WIDGET_KEY = `${PLUGIN_ID}/${WIDGET_ID}`;
const DEFAULT_SPAN = "col-span-4 row-span-1";

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

  // Retire once the user actually sends a message (typed, not via a chip) — the
  // welcome has served its purpose.
  const sentAMessage = (events ?? []).some(
    (event) => event.eventType === "message_sent",
  );
  useEffect(() => {
    if (onHome && sentAMessage) markHomeWidgetActed(WIDGET_KEY);
  }, [onHome, sentAMessage]);

  if (!onHome) return null;

  const onChip = (text: string) => {
    dispatchChatPrefill({ text, select: true });
    markHomeWidgetActed(WIDGET_KEY);
  };

  return (
    <div className={spanClassName}>
      <section
        data-testid="chat-widget-ftu-welcome"
        aria-label="Welcome — getting started"
        className="flex w-full flex-col gap-3 rounded-xl border border-white/12 bg-black/55 px-4 py-3.5 text-left"
      >
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-semibold leading-snug text-white">
            Welcome — ask me anything, or tap a starter.
          </p>
          <button
            type="button"
            data-testid="ftu-welcome-dismiss"
            aria-label="Dismiss welcome"
            onClick={() => dismissHomeWidget(WIDGET_KEY)}
            className="-mr-1 -mt-0.5 shrink-0 rounded-md p-1 text-white/45 transition-colors hover:text-white/80"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {suggestions.map((text) => (
            <button
              key={text}
              type="button"
              data-testid="ftu-welcome-chip"
              onClick={() => onChip(text)}
              className={cn(
                "rounded-full bg-accent-subtle px-3 py-1.5 text-xs font-medium text-accent",
                "transition-colors hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {text}
            </button>
          ))}
        </div>
      </section>
    </div>
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
