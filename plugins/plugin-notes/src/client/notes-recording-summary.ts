/**
 * Reviewed summaries of a voice note's recording.
 *
 * A model answer about a recording is only an editable proposal for the owner's
 * review, never a persistence instruction. The answer qualifies only when it is
 * exactly a JSON object with a nonempty `summary` and an `actions` list (bare or
 * in one fenced json block) inside the note limits; anything else is reviewed as
 * plain text by the host. Saving stays a separate owner action.
 */
export const RECORDING_SUMMARY_MAX_CHARS = 32000;
export const RECORDING_SUMMARY_MAX_ACTIONS = 20;
export const RECORDING_ACTION_MAX_CHARS = 500;
/** Combined action text, one action per line. */
export const RECORDING_ACTIONS_MAX_CHARS = 4000;
const ANSWER_MAX_CHARS = 48000;

export interface ProposedRecordingSummary {
  summary: string;
  actions: string[];
}

export function proposedRecordingSummary(
  text: string,
): ProposedRecordingSummary | undefined {
  if (typeof text !== "string" || text.length > ANSWER_MAX_CHARS) return;
  const raw = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(raw);
  let value: unknown;
  try {
    value = JSON.parse(fenced ? fenced[1] : raw);
  } catch {
    return;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "actions,summary"
  )
    return;
  const { summary, actions } = value as { summary: unknown; actions: unknown };
  if (
    typeof summary !== "string" ||
    !summary.trim() ||
    summary.length > RECORDING_SUMMARY_MAX_CHARS ||
    summary.includes("\0") ||
    !Array.isArray(actions) ||
    actions.length > RECORDING_SUMMARY_MAX_ACTIONS ||
    actions.some(
      (action: unknown) =>
        typeof action !== "string" ||
        !action.trim() ||
        action.length > RECORDING_ACTION_MAX_CHARS ||
        /[\r\n\0]/.test(action),
    )
  )
    return;
  const trimmed = (actions as string[]).map((action) => action.trim());
  if (trimmed.join("\n").length > RECORDING_ACTIONS_MAX_CHARS) return;
  return { summary, actions: trimmed };
}
