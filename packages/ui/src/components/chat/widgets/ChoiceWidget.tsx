/**
 * ChoiceWidget — inline button row for `[CHOICE:...]` blocks emitted by
 * agent actions (currently the unified APP and PLUGIN actions when they
 * need the user to disambiguate intent).
 *
 * The widget is purely presentational: it surfaces a list of options as
 * buttons and reports the selected `value` back to the caller via
 * `onChoose`. After the first selection the entire row locks so the
 * agent only ever sees one decision per prompt.
 */

import { Check, ChevronRight } from "lucide-react";
import { memo, useCallback, useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { ChatWidgetShell } from "./chat-widget-shell";
import { choicePropsEqual } from "./widget-equality";

export type ChoiceOption = {
  value: string;
  label: string;
};

export type ChoiceWidgetProps = {
  /** Stable id from the source `[CHOICE:scope id=xxx]` marker. */
  id: string;
  /** Scope hint from the marker, e.g. "app-create" or "plugin-create". */
  scope: string;
  options: ChoiceOption[];
  onChoose: (value: string) => void;
  /** When true, offer an "Other…" affordance so the user can type their own answer. */
  allowCustom?: boolean;
};

function isCancelLike(value: string, label: string): boolean {
  const v = value.toLowerCase();
  const l = label.toLowerCase();
  return v === "cancel" || v === "no" || v === "none" || l === "cancel";
}

/**
 * First-run onboarding is the primary CHOICE surface and the composer is frozen
 * behind it, so its options must read as obvious, tappable, next-step targets —
 * not the compact inline chips used for mid-conversation disambiguation. They
 * render as full-width stacked rows with a chevron affordance; the single
 * "(recommended)" option carries the accent (orange is accent-only).
 */
function isFirstRunScope(scope: string): boolean {
  return scope === "first-run" || scope.startsWith("first-run");
}

function isRecommended(label: string): boolean {
  return /\(recommended\)/i.test(label);
}

// Memoized on its data props (see `choicePropsEqual`): the transcript re-parses
// on every streamed token, handing this widget a fresh `options` array each
// tick, so a value-level comparator is what keeps a streaming turn from
// re-rendering (and remounting the selection state of) every CHOICE in view.
export const ChoiceWidget = memo(function ChoiceWidget({
  id,
  scope,
  options,
  onChoose,
  allowCustom = false,
}: ChoiceWidgetProps) {
  const [selected, setSelected] = useState<ChoiceOption | null>(null);
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState("");

  const handleChoose = useCallback(
    (option: ChoiceOption) => {
      if (selected) return;
      setSelected(option);
      onChoose(option.value);
    },
    [onChoose, selected],
  );

  const submitCustom = useCallback(() => {
    const value = customText.trim();
    if (!value || selected) return;
    const option = { value, label: value };
    setSelected(option);
    onChoose(value);
  }, [customText, onChoose, selected]);

  if (options.length === 0 && !allowCustom) return null;

  const firstRun = isFirstRunScope(scope);

  // A single-action first-run prompt ("Sign in to Eliza Cloud") is a CTA, not
  // a choice: wrapped in the collapsible shell it read as a dropdown with one
  // entry (header + "1 options" chip + chevron) and its secondary chip washed
  // out on the dark cloud surface (#15144). Render it as one full-width
  // primary button — no shell, no count chip, no chevron, and no redundant
  // selected-status line after tap.
  const soleOption =
    firstRun && !allowCustom && options.length === 1 ? options[0] : null;
  if (soleOption) {
    const isSelected = selected?.value === soleOption.value;
    return (
      <div
        className="my-2 flex min-w-0 flex-col items-stretch gap-2"
        data-choice-id={id}
        data-choice-scope={scope}
        data-testid={`choice-shell-${id}`}
      >
        <Button
          type="button"
          variant="default"
          size="default"
          disabled={selected !== null}
          aria-label={soleOption.label}
          aria-pressed={isSelected}
          data-testid={`choice-${soleOption.value}`}
          // The locked (selected) state stays at full opacity: it is the
          // confirmation the user just acted on, not a faded leftover.
          className="h-11 w-full justify-center px-4 text-sm font-medium disabled:opacity-100"
          onClick={() => handleChoose(soleOption)}
        >
          <span className="inline-flex items-center gap-2">
            {isSelected ? (
              <Check className="h-4 w-4 shrink-0" aria-hidden />
            ) : null}
            <span>{soleOption.label}</span>
          </span>
        </Button>
      </div>
    );
  }

  return (
    <ChatWidgetShell
      title={firstRun ? "Choose next step" : "Choose"}
      status={
        // Plain muted text, no pill chrome: the theme text token stays
        // readable on every surface (chat-native de-slop, supersedes the
        // #15144 pill-background fix by removing the pill).
        <span className="text-[11px] font-medium text-muted">
          {selected ? "Selected" : `${options.length} options`}
        </span>
      }
      summary={
        selected ? (
          <span role="status">Selected: {selected.label}</span>
        ) : undefined
      }
      complete={selected !== null}
      testId={`choice-shell-${id}`}
    >
      <fieldset
        className={
          firstRun
            ? "flex min-w-0 flex-col items-stretch gap-2 border-0 py-1.5"
            : "flex min-w-0 flex-wrap items-center gap-2 border-0 py-1.5"
        }
        aria-label={`Choose ${scope}`}
        data-choice-id={id}
        data-choice-scope={scope}
      >
        {options.map((option) => {
          const cancel = isCancelLike(option.value, option.label);
          const isSelected = selected?.value === option.value;
          if (firstRun) {
            // Prominent, obviously-tappable next-step rows. The recommended
            // option gets the accent; the rest use paired surface/text tokens
            // instead of the generic secondary token, which can become
            // light-on-light in native dark onboarding themes (#15516).
            // Once a pick locks the fieldset, ONLY the non-selected rows fade:
            // the selected row is promoted to the accent tokens at full
            // opacity — the blanket 40% wash on a low-alpha secondary chip
            // rendered the user's own pick white-on-white on the dark cloud
            // surface (#15144).
            const recommended = isRecommended(option.label);
            const highlighted =
              isSelected || (recommended && selected === null);
            const variant = highlighted ? "default" : "surface";
            const choiceClass = highlighted
              ? "h-11 w-full justify-between px-4 text-sm font-medium disabled:opacity-100 aria-disabled:opacity-100"
              : "h-11 w-full justify-between border border-border-strong bg-card px-4 text-sm font-medium text-txt-strong hover:bg-surface disabled:opacity-40 aria-disabled:opacity-40";
            return (
              <Button
                key={option.value}
                type="button"
                variant={variant}
                size="default"
                disabled={selected !== null}
                aria-label={option.label}
                aria-pressed={isSelected}
                data-testid={`choice-${option.value}`}
                className={choiceClass}
                onClick={() => handleChoose(option)}
              >
                <span className="inline-flex items-center gap-2">
                  {isSelected ? (
                    <Check className="h-4 w-4 shrink-0" aria-hidden />
                  ) : null}
                  <span>{option.label}</span>
                </span>
                {!isSelected ? (
                  <ChevronRight
                    className="h-4 w-4 shrink-0 opacity-70"
                    aria-hidden
                  />
                ) : null}
              </Button>
            );
          }
          const variant = cancel ? "ghost" : "outline";
          return (
            <Button
              key={option.value}
              type="button"
              variant={variant}
              size="sm"
              disabled={selected !== null}
              aria-label={option.label}
              aria-pressed={isSelected}
              data-testid={`choice-${option.value}`}
              className={
                cancel
                  ? "h-7 px-3 text-xs text-muted hover:text-txt disabled:opacity-40"
                  : "h-7 px-3 text-xs disabled:opacity-40"
              }
              onClick={() => handleChoose(option)}
            >
              {isSelected ? (
                <span className="inline-flex items-center gap-1">
                  <Check className="h-3.5 w-3.5" aria-hidden />
                  <span>{option.label}</span>
                </span>
              ) : (
                option.label
              )}
            </Button>
          );
        })}
        {allowCustom && !selected ? (
          customMode ? (
            <span className="inline-flex items-center gap-1">
              <Input
                type="text"
                aria-label="Your own answer"
                data-testid="choice-custom-input"
                value={customText}
                placeholder="Type your answer…"
                className="h-7 min-w-40 rounded-md border-border bg-transparent px-2 text-xs"
                onChange={(e) => setCustomText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitCustom();
                  }
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="choice-custom-send"
                aria-label="Send your answer"
                disabled={customText.trim().length === 0}
                className="h-7 px-3 text-xs disabled:opacity-40"
                onClick={submitCustom}
              >
                Send
              </Button>
            </span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="choice-custom-open"
              aria-label="Other"
              className="h-7 px-3 text-xs"
              onClick={() => setCustomMode(true)}
            >
              Other…
            </Button>
          )
        ) : null}
      </fieldset>
    </ChatWidgetShell>
  );
}, choicePropsEqual);
