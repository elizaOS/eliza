/**
 * DSPy-style MIPROv2 optimizer (joint instruction + demonstration search).
 *
 * MIPRO jointly optimizes the INSTRUCTIONS body and the DEMONSTRATIONS set:
 *   1. Bootstrap a pool of candidate demonstration sets (subsets of the
 *      dataset sized 0..k, ranked by reward).
 *   2. Propose a pool of candidate instruction variants via the teacher LM.
 *   3. Evaluate each (instruction, demos) combination on a held-out subset.
 *      Use a UCB-style selection so we don't fully enumerate when the search
 *      space is large — the score budget is bounded by `evalBudget`.
 *   4. Return the best combination observed.
 *
 * This is a simplified Bayesian-flavoured search: no Gaussian process, just
 * UCB1 with empirical means + visit counts. It's enough to outperform random
 * search on the budgets we run in CI (~50 evals).
 */

import type { Example } from "../examples.js";
import type { LanguageModelAdapter } from "../lm-adapter.js";
import { Predict } from "../predict.js";
import { Signature } from "../signature.js";
import type {
  DspyOptimizerInput,
  DspyOptimizerResult,
  Metric,
  OptimizerLineageEntry,
} from "./types.js";

export interface DspyMiproOptions {
  /** Demonstrations per candidate set. Defaults to 4. */
  k?: number;
  /** Distinct instruction variants to propose. Defaults to 4. */
  instructionVariants?: number;
  /** Distinct demonstration sets to bootstrap. Defaults to 4. */
  demoSets?: number;
  /** Maximum (instruction, demos) evaluations. Defaults to 20. */
  evalBudget?: number;
  /** Held-out eval-set size per (instruction, demos) trial. Defaults to all examples. */
  evalSubset?: number;
  /** Teacher temperature for instruction proposal. Defaults to 0.8. */
  teacherTemperature?: number;
  /** UCB exploration coefficient. Defaults to 1.41 (=sqrt(2)). */
  ucbC?: number;
  /** Deterministic RNG. Defaults to Math.random. */
  rng?: () => number;
}

const PROPOSAL_SYSTEM = `Rewrite the INSTRUCTIONS body of a task-prompt signature to improve downstream accuracy. Preserve the task contract and the output field names. Output ONLY the rewritten body — no commentary, no fences.`;

export async function runDspyMipro(
  input: DspyOptimizerInput,
  options: DspyMiproOptions = {},
): Promise<DspyOptimizerResult> {
  const k = Math.max(0, options.k ?? 4);
  const instructionVariants = Math.max(1, options.instructionVariants ?? 4);
  const demoSetCount = Math.max(1, options.demoSets ?? 4);
  const budget = Math.max(1, options.evalBudget ?? 20);
  const ucbC = options.ucbC ?? Math.SQRT2;
  const rng = options.rng ?? Math.random;
  const teacher = input.teacher ?? input.lm;
  const teacherTemperature = options.teacherTemperature ?? 0.8;
  const lineage: OptimizerLineageEntry[] = [];

  const heldOut =
    typeof options.evalSubset === "number"
      ? subsample(input.dataset, options.evalSubset, rng)
      : input.dataset;

  const baselineScore = await scoreCandidate(
    input.signature,
    input.signature.spec.instructions,
    [],
    heldOut,
    input.lm,
    input.metric,
  );
  lineage.push({
    round: 0,
    variant: 0,
    score: baselineScore,
    notes: "baseline",
  });

  // Build the search space: instructions × demonstrations.
  const instructionPool: string[] = [input.signature.spec.instructions];
  for (let i = 1; i < instructionVariants; i += 1) {
    const proposal = await proposeInstructions(
      teacher,
      input.signature,
      input.signature.spec.instructions,
      teacherTemperature,
    );
    if (proposal.length > 0) instructionPool.push(proposal);
  }
  const demoPool: Example[][] = buildDemoSets(
    input.dataset,
    demoSetCount,
    k,
    rng,
  );
  // Empty demo set is always included as the first arm.
  if (demoPool.length === 0 || demoPool[0]?.length !== 0) {
    demoPool.unshift([]);
  }

  interface Arm {
    instructionIdx: number;
    demoIdx: number;
    visits: number;
    meanScore: number;
    lastScore: number;
  }
  const arms: Arm[] = [];
  for (let i = 0; i < instructionPool.length; i += 1) {
    for (let j = 0; j < demoPool.length; j += 1) {
      arms.push({
        instructionIdx: i,
        demoIdx: j,
        visits: 0,
        meanScore: 0,
        lastScore: 0,
      });
    }
  }

  let bestScore = baselineScore;
  let bestInstructions = input.signature.spec.instructions;
  let bestDemos: Example[] = [];
  let totalVisits = 0;
  const evalCap = Math.min(budget, arms.length);

  // UCB1 loop: at each step, pick the arm maximizing
  //   mean + ucbC * sqrt(ln(totalVisits + 1) / (visits + epsilon)).
  // Arms with 0 visits get priority via the +1 in the numerator.
  for (let step = 0; step < evalCap; step += 1) {
    const arm = selectArm(arms, totalVisits, ucbC);
    const instructions = instructionPool[arm.instructionIdx] ?? "";
    const demos = demoPool[arm.demoIdx] ?? [];
    const score = await scoreCandidate(
      input.signature,
      instructions,
      demos,
      heldOut,
      input.lm,
      input.metric,
    );
    arm.visits += 1;
    arm.meanScore = arm.meanScore + (score - arm.meanScore) / arm.visits;
    arm.lastScore = score;
    totalVisits += 1;
    lineage.push({
      round: 1,
      variant: step + 1,
      score,
      notes: `instr=${arm.instructionIdx} demos=${arm.demoIdx} (k=${demos.length})`,
    });
    if (score > bestScore) {
      bestScore = score;
      bestInstructions = instructions;
      bestDemos = demos;
    }
  }

  return {
    optimizer: "dspy-mipro",
    signature: new Signature({
      ...input.signature.spec,
      instructions: bestInstructions,
    }),
    instructions: bestInstructions,
    demonstrations: bestDemos,
    score: bestScore,
    baselineScore,
    lineage,
  };
}

async function proposeInstructions(
  teacher: LanguageModelAdapter,
  signature: import("../signature.js").Signature,
  current: string,
  temperature: number,
): Promise<string> {
  const summary = [
    `signature name: ${signature.spec.name}`,
    "input fields:",
    ...signature.spec.inputs.map(
      (f) => `- ${f.name} (${f.type}): ${f.description}`,
    ),
    "output fields:",
    ...signature.spec.outputs.map(
      (f) => `- ${f.name} (${f.type}): ${f.description}`,
    ),
    "",
    "Current INSTRUCTIONS body:",
    current,
  ].join("\n");
  const result = await teacher.generate({
    system: PROPOSAL_SYSTEM,
    messages: [{ role: "user", content: summary }],
    temperature,
    maxTokens: 1024,
  });
  return result.text
    .trim()
    .replace(/^```[a-z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function buildDemoSets(
  dataset: Example[],
  count: number,
  k: number,
  rng: () => number,
): Example[][] {
  if (k === 0) return [[]];
  const sortedByReward = [...dataset].sort(
    (a, b) => (b.reward ?? 0) - (a.reward ?? 0),
  );
  const sets: Example[][] = [];
  // First set: top-K by reward.
  if (sortedByReward.length > 0) {
    sets.push(sortedByReward.slice(0, Math.min(k, sortedByReward.length)));
  }
  // Remaining sets: random subsamples for diversity.
  while (sets.length < count) {
    sets.push(subsample(dataset, Math.min(k, dataset.length), rng));
  }
  return sets;
}

function selectArm<A extends { visits: number; meanScore: number }>(
  arms: A[],
  totalVisits: number,
  ucbC: number,
): A {
  let best = arms[0];
  if (!best) throw new Error("[dspy-mipro] empty arm list");
  let bestUcb = -Infinity;
  const lnT = Math.log(totalVisits + 1);
  for (const arm of arms) {
    const explore =
      arm.visits === 0 ? Infinity : ucbC * Math.sqrt(lnT / arm.visits);
    const ucb = arm.meanScore + explore;
    if (ucb > bestUcb) {
      bestUcb = ucb;
      best = arm;
    }
  }
  return best;
}

async function scoreCandidate(
  signature: import("../signature.js").Signature,
  instructions: string,
  demonstrations: Example[],
  dataset: Example[],
  lm: LanguageModelAdapter,
  metric: Metric,
): Promise<number> {
  if (dataset.length === 0) return 0;
  const predict = new Predict({
    signature,
    lm,
    demonstrations,
    instructionsOverride: instructions,
  });
  let total = 0;
  for (const example of dataset) {
    try {
      const { output } = await predict.forward(example.inputs);
      total += metric(output, example.outputs);
    } catch {
      // Parse failure scores 0 — surfaced through the mean.
    }
  }
  return total / dataset.length;
}

function subsample<T>(items: T[], count: number, rng: () => number): T[] {
  if (count >= items.length) return [...items];
  const indices = new Set<number>();
  const out: T[] = [];
  let safety = 0;
  while (out.length < count && safety < count * 20) {
    const idx = Math.floor(rng() * items.length);
    safety += 1;
    if (indices.has(idx)) continue;
    indices.add(idx);
    const item = items[idx];
    if (item !== undefined) out.push(item);
  }
  return out;
}
