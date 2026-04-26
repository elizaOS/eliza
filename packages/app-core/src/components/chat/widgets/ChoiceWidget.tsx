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

import { Button } from "@elizaos/ui";
import { Check } from "lucide-react";
import { useCallback, useState } from "react";

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
};

function isCancelLike(value: string, label: string): boolean {
  const v = value.toLowerCase();
  const l = label.toLowerCase();
  return v === "cancel" || v === "no" || v === "none" || l === "cancel";
}

export function ChoiceWidget({
  id,
  scope,
  options,
  onChoose,
}: ChoiceWidgetProps) {
  const [selected, setSelected] = useState<ChoiceOption | null>(null);

  const handleChoose = useCallback(
    (option: ChoiceOption) => {
      if (selected) return;
      setSelected(option);
      onChoose(option.value);
    },
    [onChoose, selected],
  );

  if (options.length === 0) return null;

  return (
    <fieldset
      className="my-2 flex min-w-0 flex-wrap items-center gap-2 border-0 p-0"
      aria-label={`Choose ${scope}`}
      data-choice-id={id}
      data-choice-scope={scope}
    >
      {options.map((option) => {
        const cancel = isCancelLike(option.value, option.label);
        const isSelected = selected?.value === option.value;
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
      {selected ? (
        <span className="text-2xs text-muted" role="status">
          Selected: {selected.label}
        </span>
      ) : null}
    </fieldset>
  );
}
