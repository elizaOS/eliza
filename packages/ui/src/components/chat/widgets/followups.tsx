/**
 * FollowupsWidget — dismissible suggestion-chip row for `[FOLLOWUPS]` blocks
 * emitted by agent actions. Mirrors {@link ChoiceWidget} styling/tokens but
 * each chip is an *action* rather than a single mutually-exclusive choice:
 *
 *   reply    — sends the chip payload as a new user message (locks the row,
 *              same one-decision-per-prompt contract as ChoiceWidget).
 *   navigate — dispatches the `eliza:navigate:view` event so the host shell
 *              switches view. This is a passive SUGGESTION (a chip the user
 *              taps), never an auto-jump. The chip is dismissed after tap.
 *   prompt   — prefills the composer via `onPrompt` when available, otherwise
 *              falls back to sending the payload as a message.
 *
 * The whole row is dismissible (the agent's suggestions are optional), and the
 * row also locks after a `reply` so the agent only ever sees one decision.
 */

import { ArrowRight, Check, X } from "lucide-react";
import { useCallback, useState } from "react";
import { Button } from "../../ui/button";
import type { FollowupKind, FollowupOption } from "../message-followups-parser";

export type { FollowupKind, FollowupOption };

export type FollowupsWidgetProps = {
  /** Stable id from the source `[FOLLOWUPS id=xxx]` marker. */
  id: string;
  options: FollowupOption[];
  /** Send the payload as a user message (used by `reply`, and the prompt fallback). */
  onChoose: (value: string) => void;
  /**
   * Dispatch a view-switch suggestion. The host wires this to the
   * `eliza:navigate:view` custom event. `payload` is a viewId, or a viewPath
   * when it starts with `/`.
   */
  onNavigate?: (payload: string) => void;
  /** Prefill the composer with `payload`. Falls back to `onChoose` when absent. */
  onPrompt?: (payload: string) => void;
};

function iconForKind(kind: FollowupKind) {
  return kind === "navigate" ? (
    <ArrowRight className="h-3.5 w-3.5" aria-hidden />
  ) : null;
}

export function FollowupsWidget({
  id,
  options,
  onChoose,
  onNavigate,
  onPrompt,
}: FollowupsWidgetProps) {
  // A `reply` locks the whole row; other kinds leave it interactive.
  const [chosenReply, setChosenReply] = useState<FollowupOption | null>(null);
  const [dismissed, setDismissed] = useState(false);

  const handleAct = useCallback(
    (option: FollowupOption) => {
      if (chosenReply) return;
      switch (option.kind) {
        case "navigate":
          onNavigate?.(option.payload);
          setDismissed(true);
          return;
        case "prompt":
          if (onPrompt) {
            onPrompt(option.payload);
          } else {
            onChoose(option.payload);
          }
          return;
        default:
          setChosenReply(option);
          onChoose(option.payload);
      }
    },
    [chosenReply, onChoose, onNavigate, onPrompt],
  );

  if (options.length === 0 || dismissed) return null;

  return (
    <fieldset
      className="my-2 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
      aria-label="Suggested follow-ups"
      data-followups-id={id}
    >
      {options.map((option) => {
        const isChosen = chosenReply?.payload === option.payload;
        const icon = iconForKind(option.kind);
        return (
          <Button
            key={`${option.kind}:${option.payload}`}
            type="button"
            variant="outline"
            size="sm"
            disabled={chosenReply !== null}
            aria-label={option.label}
            aria-pressed={isChosen}
            data-followup-kind={option.kind}
            data-testid={`followup-${option.kind}-${option.payload}`}
            className="h-7 px-3 text-xs disabled:opacity-40"
            onClick={() => handleAct(option)}
          >
            {isChosen ? (
              <span className="inline-flex items-center gap-1">
                <Check className="h-3.5 w-3.5" aria-hidden />
                <span>{option.label}</span>
              </span>
            ) : icon ? (
              <span className="inline-flex items-center gap-1">
                <span>{option.label}</span>
                {icon}
              </span>
            ) : (
              option.label
            )}
          </Button>
        );
      })}
      {chosenReply ? (
        <span className="text-2xs text-muted" role="status">
          Selected: {chosenReply.label}
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          aria-label="Dismiss suggestions"
          data-testid="followups-dismiss"
          className="text-muted hover:text-txt"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </fieldset>
  );
}
