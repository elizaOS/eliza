/**
 * Keeps ambient chat surfaces conversational by removing action-choice regions
 * while preserving first-run controls that are required to configure the app.
 */

import { findChoiceRegions } from "../chat/message-choice-parser";

export function withoutAmbientChoices(content: string): string {
  const removable = findChoiceRegions(content).filter(
    ({ scope }) => !scope.startsWith("first-run"),
  );
  if (removable.length === 0) return content;

  let cursor = 0;
  let result = "";
  for (const region of removable) {
    result += content.slice(cursor, region.start);
    cursor = region.end;
  }
  result += content.slice(cursor);
  return result.replace(/\n{3,}/g, "\n\n").trimEnd();
}
