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
export declare function ChoiceWidget({
  id,
  scope,
  options,
  onChoose,
}: ChoiceWidgetProps): import("react/jsx-runtime").JSX.Element | null;
//# sourceMappingURL=ChoiceWidget.d.ts.map
