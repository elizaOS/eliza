/**
 * Choose how many items to include so estimated character total stays within a
 * target budget.
 *
 * WHY: Providers often fetch a superset of data, then need to keep prompt size
 * bounded. One fetch + in-memory selection avoids extra DB round trips while
 * still adapting to item size (short items -> more fit, long items -> fewer).
 */

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
    const take = count > 0 ? count : 0;
    return items.slice(items.length - take);
  }

  for (; count < items.length; count++) {
    const size = sizes[count];
    if (total + size > targetChars) break;
    total += size;
  }

  return items.slice(0, count);
}
