/**
 * Choose how many items to include so estimated character total stays within a
 * target budget.
 *
 * WHY: Providers often fetch a superset of data, then need to keep prompt size
 * bounded. One fetch + in-memory selection avoids extra DB round trips while
 * still adapting to item size (short items -> more fit, long items -> fewer).
 */

/** Target character budget for action results in provider output */
export const ACTION_RESULTS_TARGET_CHARS = 2600;
/** Target character budget for action history in provider output */
export const ACTION_HISTORY_TARGET_CHARS = 2400;
/** Target character budget for recent action runs in provider output */
export const RECENT_ACTION_RUNS_TARGET_CHARS = 2000;

export function sliceToFitBudget<T>(
  items: T[],
  estimateChars: (item: T) => number,
  targetChars: number,
  options?: { fromEnd?: boolean },
): T[] {
  if (items.length === 0) return [];
  // Zero or negative budget means no room - return empty array
  if (targetChars <= 0) return [];

  const fromEnd = options?.fromEnd ?? false;
  let total = 0;
  let count = 0;

  // Calculate all sizes upfront to avoid calling estimateChars twice per item
  // (once for budget check and once for accumulation)
  const sizes = items.map(estimateChars);
  
  if (fromEnd) {
    for (let index = items.length - 1; index >= 0; index--) {
      const size = sizes[index];
      if (total + size > targetChars) break;
      total += size;
      count++;
    }
    // Return empty array if no items fit within budget (count is 0)
    return items.slice(items.length - count);
  }

  // Forward iteration (fromEnd = false, the default)
  for (; count < items.length; count++) {
    const size = sizes[count];
    if (total + size > targetChars) break;
    total += size;
  }

  // Return empty array if no items fit within budget (count is 0)
  return items.slice(0, count);
}

/**
 * Estimates character count for an action result entry (used for budget slicing).
 */
export function estimateActionResultChars(result: {
  text?: string;
  error?: unknown;
  values?: Record<string, unknown>;
}): number {
  let size = String(result.text || "").length + String(result.error || "").length;
  try {
    size += JSON.stringify(result.values || {}).length;
  } catch {
    // Ignore serialization errors
  }
  return size + 80;
}

/**
 * Estimates character count for an action run entry (used for budget slicing).
 */
export function estimateActionRunChars([runId, memories]: [string, Array<{
  content?: {
    actionName?: string;
    actionStatus?: string;
    planStep?: string;
    text?: string;
    error?: string;
  };
}>]): number {
  const textChars = memories.reduce((sum, memory) => {
    const content = memory.content;
    return (
      sum +
      String(content?.actionName || "").length +
      String(content?.actionStatus || "").length +
      String(content?.planStep || "").length +
      String(content?.text || "").length +
      String(content?.error || "").length
    );
  }, 0);
  return textChars + runId.length + 80;
// Note: total includes fixed buffer to ensure adequate space for additional prompt data
}
