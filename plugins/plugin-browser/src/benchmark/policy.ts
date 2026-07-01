/**
 * Benchmark policies (#9476).
 *
 * A policy maps an observation to the next action — the "agent" half of the
 * benchmark loop. The harness is policy-agnostic: the committed run uses the
 * deterministic {@link OraclePolicy} (reproducible, zero model cost), while the
 * same seam accepts an LLM-backed policy (read the `#wob-query` goal from the
 * observation, choose an action) so the suite can later gate on a live model —
 * mirroring how OSWorld's `*.real.test.ts` drives the adapter with a live model.
 *
 * {@link NoopPolicy} is the negative baseline: it does nothing, so a working
 * reward function must score every task 0 under it. That proves the reward
 * discriminates rather than always returning 1.
 */

import type {
  BenchmarkAction,
  BenchmarkObservation,
  BenchmarkStepResult,
  BenchmarkTask,
} from "./types.js";

export interface BenchmarkPolicyInput {
  observation: BenchmarkObservation;
  task: BenchmarkTask;
  seed: number;
  history: BenchmarkStepResult[];
}

export interface BenchmarkPolicy {
  readonly name: string;
  act(input: BenchmarkPolicyInput): Promise<BenchmarkAction>;
}

/** Replays the task's known-correct action sequence, then signals `done`. */
export class OraclePolicy implements BenchmarkPolicy {
  readonly name = "oracle";
  async act({
    task,
    seed,
    history,
  }: BenchmarkPolicyInput): Promise<BenchmarkAction> {
    const plan = task.oracle(seed);
    const next = plan[history.length];
    return next ?? { type: "done", note: "oracle plan exhausted" };
  }
}

/** Negative baseline: terminates immediately without acting. */
export class NoopPolicy implements BenchmarkPolicy {
  readonly name = "noop";
  async act(): Promise<BenchmarkAction> {
    return { type: "done", note: "noop" };
  }
}

/**
 * Adversarial baseline: takes the oracle's first action but inverts its intent
 * (wrong selector / wrong text) to confirm the reward rejects near-misses.
 */
export class WrongPolicy implements BenchmarkPolicy {
  readonly name = "wrong";
  async act({
    task,
    seed,
    history,
  }: BenchmarkPolicyInput): Promise<BenchmarkAction> {
    if (history.length > 0) return { type: "done", note: "wrong-done" };
    const first = task.oracle(seed)[0];
    if (!first) return { type: "done", note: "wrong-empty" };
    if (
      first.type === "type" ||
      first.type === "fill" ||
      first.type === "select"
    ) {
      return {
        ...first,
        value: `${first.value ?? ""}-WRONG`,
        note: "wrong-text",
      };
    }
    // For click/check, point at a selector that does not exist → no effect.
    return { ...first, selector: "#wob-nonexistent", note: "wrong-target" };
  }
}
