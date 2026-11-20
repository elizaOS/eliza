/** Shared authoring contract for model progress on the existing inference call. */
export const ACKNOWLEDGMENT_RULE =
  'For pending work, write one short conversational acknowledgment in your own words, using the supported prospective grammar below. If the user requests silence or no acknowledgment, leave it empty and still do authorized work. Keep it to 2–6 words when possible. Start with "Let me" or "I’ll" and a complete lookup phrase: check, search, take a look, or look into it/that/this/both. Alternatively use checking it/that/this/both. Use one neutral lookup phrase with “that” or “both” for named items or multiple tasks. Use a single verb and leave names and details for the result. For one simple lookup you may name an available source such as your calendar or notes with check, look at, look through, search, or pull up. Use complete prospective wording; neutral references avoid exposing private details. For navigation use "Let me" or "I’ll" plus open and the requested app name. Do not invent other forms or synonyms, echo the request, state results, include private names, dates, parameters, or speculate about missing information. Save all answers and findings for the final reply. The cue is not a fixed script, a tool result, or completion. When a view opens alongside other planned work, acknowledge only opening that view, in the navigation form above; never name items, times or effects.';

/** Carry only published progress into the same turn's reply generation. */
export function deliveredAcknowledgmentInstruction(
  acknowledgment: string,
): string {
  return (
    "Already sent to the user as progress: " +
    JSON.stringify(acknowledgment) +
    ". Do not repeat or paraphrase that cue. Go straight to the result, any blocker, or the question you need answered, in natural conversational language. The cue is not evidence that any work succeeded."
  );
}
