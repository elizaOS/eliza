/** Normalizes complete model-visible labels for delegated tasks. */

import { toWellFormedUnicode } from "@elizaos/core";

export function labelFrom(task: string, index: number): string {
  const cleaned = task.replace(/\s+/g, " ").trim();
  const wellFormed = toWellFormedUnicode(cleaned);
  return wellFormed || `task-${index + 1}`;
}
