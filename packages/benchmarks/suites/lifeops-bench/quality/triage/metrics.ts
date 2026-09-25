/**
 * Triage precision/recall metrics (#10723) — pure, code-under-test-free.
 *
 * Gold labels and predictions are plain string arrays paired by index. The
 * class list is passed explicitly (the classifier's frozen five-class
 * taxonomy) so an unexpected label in either array is a hard error, never a
 * silently dropped row.
 */

export interface ClassScore {
  label: string;
  /** True positives / predicted positives; 1 when the class was never predicted. */
  precision: number;
  /** True positives / gold positives; 1 when the class has no gold items. */
  recall: number;
  f1: number;
  goldCount: number;
  predictedCount: number;
  truePositives: number;
}

export interface TriageScore {
  perClass: Record<string, ClassScore>;
  accuracy: number;
  macroF1: number;
  total: number;
  correct: number;
}

export function scoreTriage(
  labels: readonly string[],
  gold: readonly string[],
  predicted: readonly string[],
): TriageScore {
  if (gold.length !== predicted.length) {
    throw new Error(
      `[lifeops-quality] gold/predicted length mismatch: ${gold.length} vs ${predicted.length}`,
    );
  }
  if (gold.length === 0) {
    throw new Error("[lifeops-quality] cannot score an empty corpus");
  }
  const known = new Set(labels);
  for (const [index, value] of gold.entries()) {
    if (!known.has(value)) {
      throw new Error(
        `[lifeops-quality] unknown gold label at index ${index}: ${value}`,
      );
    }
  }
  for (const [index, value] of predicted.entries()) {
    if (!known.has(value)) {
      throw new Error(
        `[lifeops-quality] unknown predicted label at index ${index}: ${value}`,
      );
    }
  }

  const perClass: Record<string, ClassScore> = {};
  let correct = 0;
  for (let i = 0; i < gold.length; i++) {
    if (gold[i] === predicted[i]) correct += 1;
  }
  for (const label of labels) {
    let truePositives = 0;
    let goldCount = 0;
    let predictedCount = 0;
    for (let i = 0; i < gold.length; i++) {
      const isGold = gold[i] === label;
      const isPredicted = predicted[i] === label;
      if (isGold) goldCount += 1;
      if (isPredicted) predictedCount += 1;
      if (isGold && isPredicted) truePositives += 1;
    }
    const precision = predictedCount === 0 ? 1 : truePositives / predictedCount;
    const recall = goldCount === 0 ? 1 : truePositives / goldCount;
    const f1 =
      precision + recall === 0
        ? 0
        : (2 * precision * recall) / (precision + recall);
    perClass[label] = {
      label,
      precision,
      recall,
      f1,
      goldCount,
      predictedCount,
      truePositives,
    };
  }

  const f1Values = labels.map((label) => {
    const score = perClass[label];
    if (!score) {
      throw new Error(`[lifeops-quality] missing per-class score for ${label}`);
    }
    return score.f1;
  });
  return {
    perClass,
    accuracy: correct / gold.length,
    macroF1: f1Values.reduce((acc, f1) => acc + f1, 0) / f1Values.length,
    total: gold.length,
    correct,
  };
}
