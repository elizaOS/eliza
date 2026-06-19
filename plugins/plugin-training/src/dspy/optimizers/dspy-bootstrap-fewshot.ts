/**
 * DSPy-style BootstrapFewshot optimizer.
 *
 * Selects top-K examples from the dataset (ranked by reward, then by metric
 * score against the baseline) and emits them as the demonstration set
 * attached to a Predict module. Unlike the legacy `bootstrap-fewshot.ts`
 * which renders demos as text appended to a baseline prompt, this version
 * keeps demonstrations as a typed `Example[]` so they round-trip through
 * Signature.render() at run time.
 */

import type { Example } from "../examples.js";
import { Predict } from "../predict.js";
import type {
  DspyOptimizerInput,
  DspyOptimizerResult,
  OptimizerLineageEntry,
} from "./types.js";

export interface DspyBootstrapFewshotOptions {
  /** Demonstrations to keep. Defaults to 5. */
  k?: number;
  /**
   * When true, rank examples by their per-example metric score against the
   * baseline signature instead of by the recorded `reward`. Slower (one LM
   * call per example) but works when rewards are missing.
   */
  rankByMetric?: boolean;
}

export async function runDspyBootstrapFewshot(
  input: DspyOptimizerInput,
  options: DspyBootstrapFewshotOptions = {},
): Promise<DspyOptimizerResult> {
  const k = Math.max(1, options.k ?? 5);
  const lineage: OptimizerLineageEntry[] = [];

  const baselineScore = await evaluate(input, []);
  lineage.push({
    round: 0,
    variant: 0,
    score: baselineScore,
    notes: "baseline",
  });

  const ranked = await rankExamples(input, options);
  const demos = ranked.slice(0, Math.min(k, ranked.length));

  const optimizedScore = await evaluate(input, demos);
  lineage.push({
    round: 1,
    variant: 1,
    score: optimizedScore,
    notes: `injected ${demos.length} demonstrations`,
  });

  return {
    optimizer: "dspy-bootstrap-fewshot",
    signature: input.signature,
    instructions: input.signature.spec.instructions,
    demonstrations: demos,
    score: optimizedScore,
    baselineScore,
    lineage,
  };
}

async function evaluate(
  input: DspyOptimizerInput,
  demonstrations: Example[],
): Promise<number> {
  if (input.dataset.length === 0) return 0;
  const predict = new Predict({
    signature: input.signature,
    lm: input.lm,
    demonstrations,
  });
  let total = 0;
  let counted = 0;
  for (const example of input.dataset) {
    try {
      const { output } = await predict.forward(example.inputs);
      total += input.metric(output, example.outputs);
      counted += 1;
    } catch {
      // Parse failure scores 0 — the optimizer must learn to produce
      // signature-compatible output. Avoid burying the failure with `?? 0`
      // at the metric layer.
      counted += 1;
    }
  }
  return counted === 0 ? 0 : total / counted;
}

async function rankExamples(
  input: DspyOptimizerInput,
  options: DspyBootstrapFewshotOptions,
): Promise<Example[]> {
  if (options.rankByMetric) {
    const scored: Array<{ example: Example; score: number }> = [];
    for (const example of input.dataset) {
      const predict = new Predict({
        signature: input.signature,
        lm: input.lm,
        demonstrations: [],
      });
      let score = 0;
      try {
        const { output } = await predict.forward(example.inputs);
        score = input.metric(output, example.outputs);
      } catch {
        score = 0;
      }
      scored.push({ example, score });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score || (b.example.reward ?? 0) - (a.example.reward ?? 0),
    );
    return scored.map((s) => s.example);
  }
  const ordered = input.dataset.map((example, index) => ({
    example,
    index,
    reward: example.reward ?? 0,
  }));
  ordered.sort((a, b) => b.reward - a.reward || a.index - b.index);
  return ordered.map((entry) => entry.example);
}
