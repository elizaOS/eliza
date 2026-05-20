/**
 * Dedupes rows by questionNumber, keeping the first row seen.
 * Callers should order rows so the preferred market match comes first.
 */
interface QuestionMarketRow {
  questionNumber: number;
  marketId: string | null;
}

function shouldReplaceRow<T extends QuestionMarketRow>(
  current: T,
  candidate: T
): boolean {
  return current.marketId === null && candidate.marketId !== null;
}

export function dedupeQuestionMarketRows<T extends QuestionMarketRow>(
  rows: T[]
): T[] {
  const deduped = new Map<number, T>();

  for (const row of rows) {
    const current = deduped.get(row.questionNumber);
    if (!current || shouldReplaceRow(current, row)) {
      deduped.set(row.questionNumber, row);
    }
  }

  return [...deduped.values()];
}
