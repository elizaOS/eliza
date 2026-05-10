/**
 * Bootstrap-fewshot optimizer.
 *
 * Picks the top-K examples from the dataset (ranked by reward, then by
 * agreement against the baseline) and injects them as in-context
 * demonstrations into the prompt. The output prompt is the baseline plus a
 * `Demonstrations:` block that the runtime threads through unchanged.
 *
 * This is the cheapest optimizer — it does not propose new instructions, only
 * conditions the existing prompt on a curated few-shot set. It is the fallback
 * used when threshold-fired bootstrap runs need fast turnaround.
 */

import type {
  LlmAdapter,
  OptimizationExample,
  OptimizerLineageEntry,
  OptimizerResult,
  PromptScorer,
} from "./types.js";

export interface BootstrapFewshotOptions {
  /** Number of demonstrations to inject. Defaults to 5. */
  k?: number;
  /**
   * Optional scorer override. When supplied, examples are ranked by score
   * against the baseline prompt instead of by `example.reward`.
   */
  rankByScorer?: boolean;
}

export interface BootstrapFewshotInput {
  baselinePrompt: string;
  dataset: OptimizationExample[];
  scorer: PromptScorer;
  llm: LlmAdapter;
  options?: BootstrapFewshotOptions;
}

const DEMONSTRATION_HEADER = "Demonstrations:";

/**
 * Trim a demonstration's `input.user` down to the bits that meaningfully
 * teach the model. The recorded planner inputs include the full provider
 * block + tool catalog + conversation history (often ~30K chars), but for
 * ICL we only need the user's current-turn request. Pulls the user message
 * out of the recorded transcript, falls back to a head/tail truncation if
 * we can't find one cleanly. Capped at ~600 chars so 5 demos stay well
 * under the model's context budget.
 */
function trimDemonstrationInput(rawInput: string): string {
  // Look for a `User:` / `User message:` / final speaker line. Recorded
  // planner inputs typically end with "<TURN-N>\nuser: <message>" or a
  // similar marker.
  const userMatch =
    rawInput.match(/(?:^|\n)user(?:\s+message)?\s*:\s*([^\n]+(?:\n(?!\w+:)[^\n]+)*)/i) ??
    rawInput.match(/(?:^|\n)user_message\s*:\s*([^\n]+(?:\n(?!\w+:)[^\n]+)*)/i);
  const candidate = userMatch?.[1]?.trim();
  if (candidate && candidate.length > 0 && candidate.length <= 600) {
    return candidate;
  }
  if (candidate && candidate.length > 0) {
    return candidate.slice(0, 600).trimEnd() + " …";
  }
  // Fallback: first 400 chars + "..." + last 200 chars so the model sees
  // both the framing and the request without the middle bulk.
  if (rawInput.length <= 600) return rawInput;
  return (
    rawInput.slice(0, 400).trimEnd() +
    "\n…\n" +
    rawInput.slice(-200).trimStart()
  );
}

/**
 * Render a demonstration block exactly the way the runtime wires it back into
 * the system prompt. Public so `OptimizedPromptService` can rebuild the
 * combined prompt at load time.
 */
export function renderDemonstrations(examples: OptimizationExample[]): string {
  if (examples.length === 0) return "";
  const lines: string[] = [DEMONSTRATION_HEADER, ""];
  let idx = 1;
  for (const example of examples) {
    lines.push(`Example ${idx}:`);
    lines.push(`Input:\n${trimDemonstrationInput(example.input.user)}`);
    lines.push(`Expected:\n${example.expectedOutput}`);
    lines.push("");
    idx += 1;
  }
  return lines.join("\n").trimEnd();
}

/**
 * Combine a baseline prompt with a rendered demonstration block. Idempotent
 * when `examples` is empty.
 */
export function withDemonstrations(
  baseline: string,
  examples: OptimizationExample[],
): string {
  if (examples.length === 0) return baseline;
  const demos = renderDemonstrations(examples);
  return `${baseline.trimEnd()}\n\n${demos}\n`;
}

export async function runBootstrapFewshot(
  input: BootstrapFewshotInput,
): Promise<OptimizerResult> {
  const k = Math.max(1, input.options?.k ?? 5);
  const lineage: OptimizerLineageEntry[] = [];
  const baselineScore = await input.scorer(input.baselinePrompt, input.dataset);
  lineage.push({
    round: 0,
    variant: 0,
    score: baselineScore,
    notes: "baseline",
  });

  const ranked = await rankExamples(input);
  const fewShot = ranked.slice(0, Math.min(k, ranked.length));

  const optimizedPrompt = withDemonstrations(input.baselinePrompt, fewShot);
  const optimizedScore = await input.scorer(optimizedPrompt, input.dataset);
  lineage.push({
    round: 1,
    variant: 1,
    score: optimizedScore,
    notes: `injected ${fewShot.length} demonstrations`,
  });

  return {
    optimizedPrompt,
    score: optimizedScore,
    baseline: baselineScore,
    lineage,
    fewShotExamples: fewShot,
  };
}

async function rankExamples(
  input: BootstrapFewshotInput,
): Promise<OptimizationExample[]> {
  if (input.options?.rankByScorer) {
    const scored: Array<{ example: OptimizationExample; score: number }> = [];
    for (const example of input.dataset) {
      const score = await input.scorer(input.baselinePrompt, [example]);
      scored.push({ example, score });
    }
    // Pull demonstrations the baseline already gets right; they are the
    // highest-confidence anchors for the model to imitate. Tie-break by
    // reward when the scorer is uninformative.
    scored.sort(
      (a, b) =>
        b.score - a.score || (b.example.reward ?? 0) - (a.example.reward ?? 0),
    );
    return scored.map((entry) => entry.example);
  }

  // Reward-first ranking. Examples without a recorded reward fall through
  // to a stable order at the back so the dataset's natural ordering wins
  // the tie-break.
  const ordered = input.dataset.map((example, index) => ({
    example,
    index,
    reward: example.reward ?? 0,
  }));
  ordered.sort((a, b) => b.reward - a.reward || a.index - b.index);
  return ordered.map((entry) => entry.example);
}
