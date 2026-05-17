/**
 * Tests for the orchestrator's gated persist step.
 *
 * Exercises `gatedPersistNativeResult` end-to-end with a stub
 * `OptimizedPromptService` against a real temp filesystem store. Validates:
 *
 *   - A candidate that beats the incumbent on the held-out replay set is
 *     promoted (artifact written, no rejected file).
 *   - A candidate that regresses is rejected (rejected file written, no
 *     artifact rotation).
 *   - The W1-P3 retention budget (5 promoted artifacts) is enforced by
 *     pruning the oldest after each successful promote.
 *
 * The native backend itself is not invoked here — we feed a synthetic
 * `NativeBackendResult`-shaped payload so the gate logic, persistence wiring,
 * and pruning behavior are deterministic and don't need a model.
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OptimizationExample, PromptScorer } from "../optimizers/types.js";
import { REJECTED_DIRNAME } from "./artifact-store.js";
import { gatedPersistNativeResult } from "./promotion-persist.js";

interface PromotionFixture {
  dataset: OptimizationExample[];
  holdoutSet: OptimizationExample[];
}

interface StubServiceState {
  storeRoot: string;
  currentPrompt: string | null;
  promotedWrites: number;
}

function makeStubService(state: StubServiceState) {
  return {
    setPrompt: async (
      task: string,
      artifact: { prompt: string; generatedAt: string },
    ) => {
      state.promotedWrites += 1;
      state.currentPrompt = artifact.prompt;
      const dir = join(state.storeRoot, task);
      await mkdir(dir, { recursive: true });
      const stamp = artifact.generatedAt.replace(/[^0-9]/g, "");
      const path = join(dir, `${stamp}.json`);
      await writeFile(path, JSON.stringify(artifact, null, 2), "utf-8");
      return path;
    },
    getPrompt: (_task: string) =>
      state.currentPrompt
        ? {
            prompt: state.currentPrompt,
            optimizerSource: "instruction-search" as const,
          }
        : null,
    getStoreRoot: () => state.storeRoot,
  };
}

const replayDataset: OptimizationExample[] = [
  { id: "a", input: { user: "row a" }, expectedOutput: "ref a" },
  { id: "b", input: { user: "row b" }, expectedOutput: "ref b" },
];

/**
 * Build a scorer that returns fixed scores keyed by prompt body.
 *
 * Each lookup is deterministic so the gate's stddev arithmetic is also
 * deterministic and we can assert exact promote/reject outcomes.
 */
function fixedScorer(scores: Record<string, number>): PromptScorer {
  return async (prompt) => {
    const score = scores[prompt];
    if (typeof score !== "number") {
      throw new Error(`[test] missing fixed score for prompt "${prompt}"`);
    }
    return score;
  };
}

const baselinePrompt = "incumbent prompt body";
const goodCandidatePrompt = "candidate prompt body — improved";
const badCandidatePrompt = "candidate prompt body — regression";

function makeNativeResult(
  optimizedPrompt: string,
  scorer: PromptScorer,
): Parameters<typeof gatedPersistNativeResult>[0]["result"] {
  return {
    optimizer: "instruction-search",
    datasetSize: replayDataset.length,
    score: 0.9,
    baselineScore: 0.5,
    result: {
      optimizedPrompt,
      lineage: [{ round: 0, variant: 0, score: 0.5, notes: "baseline" }],
    },
    dataset: replayDataset,
    scorer,
  };
}

describe("gatedPersistNativeResult", () => {
  let tempRoot: string;
  let state: StubServiceState;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "promotion-gate-"));
    state = {
      storeRoot: tempRoot,
      currentPrompt: null,
      promotedWrites: 0,
    };
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("promotes a candidate that beats the incumbent", async () => {
    const scorer = fixedScorer({
      [baselinePrompt]: 0.5,
      [goodCandidatePrompt]: 0.9,
    });
    const service = makeStubService(state);
    const out = await gatedPersistNativeResult({
      task: "action_planner",
      datasetPath: "/tmp/dataset.jsonl",
      runId: "run-test-1",
      baselinePrompt,
      result: makeNativeResult(goodCandidatePrompt, scorer),
      service,
      notesPrefix: [],
    });
    expect(out.invoked).toBe(true);
    expect(out.artifactPath).toBeTruthy();
    expect(state.promotedWrites).toBe(1);
    expect(state.currentPrompt).toBe(goodCandidatePrompt);
    const promoteLine = out.notes?.find((n) => n.includes("PROMOTE"));
    expect(promoteLine).toBeTruthy();
    // No rejected file should be written.
    const rejectedDir = join(tempRoot, "action_planner", REJECTED_DIRNAME);
    expect(existsSync(rejectedDir)).toBe(false);
  });

  it("rejects a candidate that regresses and writes candidate_rejected_<ts>.json", async () => {
    const scorer = fixedScorer({
      [baselinePrompt]: 0.8,
      [badCandidatePrompt]: 0.3,
    });
    const service = makeStubService(state);
    const out = await gatedPersistNativeResult({
      task: "action_planner",
      datasetPath: "/tmp/dataset.jsonl",
      runId: "run-test-2",
      baselinePrompt,
      result: makeNativeResult(badCandidatePrompt, scorer),
      service,
      notesPrefix: [],
    });
    expect(out.invoked).toBe(true);
    expect(out.artifactPath).toBeUndefined();
    expect(state.promotedWrites).toBe(0);
    expect(state.currentPrompt).toBeNull();
    const rejectLine = out.notes?.find((n) => n.includes("REJECT"));
    expect(rejectLine).toBeTruthy();
    // Confirm the rejected file landed under <task>/rejected/.
    const rejectedDir = join(tempRoot, "action_planner", REJECTED_DIRNAME);
    expect(existsSync(rejectedDir)).toBe(true);
    const rejectedFiles = readdirSync(rejectedDir).filter((f) =>
      f.startsWith("candidate_rejected_"),
    );
    expect(rejectedFiles.length).toBe(1);
    // Sanity-check the rejected file contents include the score block.
    const rejectedPath = join(rejectedDir, rejectedFiles[0] as string);
    const parsed = JSON.parse(readFileSync(rejectedPath, "utf-8")) as {
      candidatePrompt: string;
      reason: string;
      scores: { delta: number };
    };
    expect(parsed.candidatePrompt).toBe(badCandidatePrompt);
    expect(parsed.scores.delta).toBeLessThan(0);
    expect(parsed.reason).toMatch(/did not improve/i);
  });

  it("prunes the on-disk store to the most recent 5 promoted artifacts", async () => {
    // Seed 7 fake promoted artifacts with monotonically increasing mtimes so
    // the prune step has something concrete to delete.
    const taskDir = join(tempRoot, "action_planner");
    rmSync(taskDir, { recursive: true, force: true });
    await mkdir(taskDir, { recursive: true });
    const baseMs = Date.now() - 7 * 1000;
    const seedNames: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const name = `2020010100000${i}.json`;
      const p = join(taskDir, name);
      writeFileSync(p, "{}", "utf-8");
      const seconds = (baseMs + i * 1000) / 1000;
      utimesSync(p, seconds, seconds);
      seedNames.push(name);
    }

    // Now promote one more candidate; the post-promote prune should knock the
    // oldest seeded files out and leave only the 5 most-recent files.
    const scorer = fixedScorer({
      [baselinePrompt]: 0.5,
      [goodCandidatePrompt]: 0.95,
    });
    const service = makeStubService(state);
    await gatedPersistNativeResult({
      task: "action_planner",
      datasetPath: "/tmp/dataset.jsonl",
      runId: "run-test-prune",
      baselinePrompt,
      result: makeNativeResult(goodCandidatePrompt, scorer),
      service,
      notesPrefix: [],
    });

    const remaining = readdirSync(taskDir).filter((f) => f.endsWith(".json"));
    expect(remaining.length).toBe(5);
    // The freshly-promoted file should be among the survivors.
    expect(state.promotedWrites).toBe(1);
  });

  it("prefers the holdout set over the full dataset when present", async () => {
    // Build two scorers — one keyed only on holdout-prompt-lookup and one
    // keyed only on full-dataset-prompt-lookup — so we can prove the gate
    // ran against the holdout subset (the other would throw if hit).
    const holdoutOnly: PromotionFixture = {
      holdoutSet: [{ id: "h-1", input: { user: "h" }, expectedOutput: "h" }],
      // dataset includes other rows but they must not be scored against.
      dataset: [
        { id: "t-1", input: { user: "t" }, expectedOutput: "t" },
        { id: "h-1", input: { user: "h" }, expectedOutput: "h" },
      ],
    };
    const scorerCalls: OptimizationExample[][] = [];
    const trackingScorer: PromptScorer = async (prompt, examples) => {
      scorerCalls.push(examples);
      return prompt === goodCandidatePrompt ? 0.9 : 0.5;
    };

    const service = makeStubService(state);
    await gatedPersistNativeResult({
      task: "action_planner",
      datasetPath: "/tmp/dataset.jsonl",
      runId: "run-test-holdout",
      baselinePrompt,
      result: {
        optimizer: "instruction-search",
        datasetSize: holdoutOnly.dataset.length,
        score: 0.9,
        baselineScore: 0.5,
        result: {
          optimizedPrompt: goodCandidatePrompt,
          lineage: [{ round: 0, variant: 0, score: 0.5 }],
        },
        dataset: holdoutOnly.dataset,
        holdoutSet: holdoutOnly.holdoutSet,
        scorer: trackingScorer,
      },
      service,
      notesPrefix: [],
    });

    // Every scorer call must have been against the holdout subset only.
    expect(scorerCalls.length).toBeGreaterThan(0);
    for (const examples of scorerCalls) {
      for (const ex of examples) {
        expect(ex.id).toBe("h-1");
      }
    }
  });

  it("falls back to the full dataset when no holdout is supplied", async () => {
    const scorer = fixedScorer({
      [baselinePrompt]: 0.5,
      [goodCandidatePrompt]: 0.9,
    });
    const service = makeStubService(state);
    const out = await gatedPersistNativeResult({
      task: "action_planner",
      datasetPath: "/tmp/dataset.jsonl",
      runId: "run-test-fallback-dataset",
      baselinePrompt,
      result: makeNativeResult(goodCandidatePrompt, scorer),
      service,
      notesPrefix: [],
    });
    const fallbackLine = out.notes?.find((n) =>
      n.includes("gate_dataset=full-dataset"),
    );
    expect(fallbackLine).toBeTruthy();
  });

  it("handles missing OptimizedPromptService getPrompt gracefully (falls back to baseline)", async () => {
    const scorer = fixedScorer({
      [baselinePrompt]: 0.5,
      [goodCandidatePrompt]: 0.9,
    });
    const service = makeStubService(state);
    // Strip getPrompt to simulate an older build of the service.
    const trimmed = {
      setPrompt: service.setPrompt,
      getStoreRoot: service.getStoreRoot,
    } as Parameters<typeof gatedPersistNativeResult>[0]["service"];
    const out = await gatedPersistNativeResult({
      task: "action_planner",
      datasetPath: "/tmp/dataset.jsonl",
      runId: "run-test-fallback",
      baselinePrompt,
      result: makeNativeResult(goodCandidatePrompt, scorer),
      service: trimmed,
      notesPrefix: [],
    });
    expect(out.invoked).toBe(true);
    const noteLine = out.notes?.find((n) =>
      n.includes("incumbent_source=baseline"),
    );
    expect(noteLine).toBeTruthy();
  });
});
