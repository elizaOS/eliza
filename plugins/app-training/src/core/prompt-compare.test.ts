import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LlmAdapter, OptimizationExample } from "../optimizers/index.js";
import { comparePrompts, formatComparisonSummary } from "./prompt-compare.js";

/** Deterministic adapter that returns whatever string the test wires
 *  up per (system, user) key. Mirrors the "in-memory adapter" pattern
 *  the optimizer modules use for unit testing — no HTTP, no fixtures. */
function makeAdapter(
  responder: (input: { system?: string; user: string }) => string,
): LlmAdapter {
  return {
    async complete(input) {
      return responder({ system: input.system, user: input.user });
    },
  };
}

const exampleA: OptimizationExample = {
  id: "a",
  input: { user: "say hello in english" },
  expectedOutput: "hello world",
};

const exampleB: OptimizationExample = {
  id: "b",
  input: { user: "say hello in spanish" },
  expectedOutput: "hola mundo",
};

describe("comparePrompts", () => {
  it("reports passed=true when variant matches baseline behavior", async () => {
    // Both prompts produce the historical reference exactly.
    const adapter = makeAdapter(({ user }) => {
      if (user.includes("english")) return "hello world";
      if (user.includes("spanish")) return "hola mundo";
      return "";
    });
    const result = await comparePrompts({
      baselinePrompt: "verbose baseline prompt",
      variantPrompt: "compressed variant prompt",
      dataset: [exampleA, exampleB],
      adapter,
    });
    expect(result.examplesScored).toBe(2);
    expect(result.baselineScore).toBe(1);
    expect(result.variantScore).toBe(1);
    expect(result.delta).toBe(0);
    expect(result.passed).toBe(true);
    expect(result.scorer).toBe("agreement");
    expect(result.mode).toBe("vs_historical");
  });

  it("flags passed=false when variant regresses past tolerance", async () => {
    // Baseline matches; variant returns gibberish.
    const adapter = makeAdapter(({ system, user }) => {
      if (system === "good") {
        return user.includes("english") ? "hello world" : "hola mundo";
      }
      return "qzqz nope";
    });
    const result = await comparePrompts({
      baselinePrompt: "good",
      variantPrompt: "bad",
      dataset: [exampleA, exampleB],
      adapter,
    });
    expect(result.baselineScore).toBe(1);
    expect(result.variantScore).toBe(0);
    expect(result.delta).toBe(-1);
    expect(result.passed).toBe(false);
  });

  it("uses planner_action scorer when task=action_planner", async () => {
    const dataset: OptimizationExample[] = [
      {
        id: "p1",
        input: { user: "what should I do" },
        expectedOutput: '{"action": "REPLY"}',
      },
      {
        id: "p2",
        input: { user: "another decision" },
        expectedOutput: '{"action": "IGNORE"}',
      },
    ];
    // Both prompts agree on action despite different rationale text.
    const adapter = makeAdapter(({ user }) => {
      if (user.includes("what should I do")) {
        return '{"action": "REPLY", "thought": "answer the user"}';
      }
      return '{"action": "IGNORE", "thought": "not addressed"}';
    });
    const result = await comparePrompts({
      baselinePrompt: "old planner",
      variantPrompt: "new planner",
      dataset,
      task: "action_planner",
      adapter,
    });
    expect(result.scorer).toBe("planner_action");
    expect(result.baselineScore).toBe(1);
    expect(result.variantScore).toBe(1);
    expect(result.passed).toBe(true);
  });

  it("respects maxExamples cap", async () => {
    const adapter = makeAdapter(() => "hello world");
    const result = await comparePrompts({
      baselinePrompt: "p1",
      variantPrompt: "p2",
      dataset: [exampleA, exampleB],
      maxExamples: 1,
      adapter,
    });
    expect(result.examplesScored).toBe(1);
  });

  it("loads dataset from a JSONL file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-compare-"));
    try {
      const path = join(dir, "dataset.jsonl");
      const rows = [
        {
          format: "eliza_native_v1",
          request: {
            system: "ignored at runtime; we substitute our test prompts",
            messages: [{ role: "user", content: "say hello in english" }],
          },
          response: { text: "hello world" },
        },
        {
          format: "eliza_native_v1",
          request: {
            messages: [{ role: "user", content: "say hello in spanish" }],
          },
          response: { text: "hola mundo" },
        },
      ];
      await writeFile(path, rows.map((r) => JSON.stringify(r)).join("\n"));

      const adapter = makeAdapter(({ user }) =>
        user.includes("english") ? "hello world" : "hola mundo",
      );
      const result = await comparePrompts({
        baselinePrompt: "baseline",
        variantPrompt: "variant",
        dataset: path,
        adapter,
      });
      expect(result.examplesScored).toBe(2);
      expect(result.baselineScore).toBe(1);
      expect(result.variantScore).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pairwise mode flags passed=false on output divergence", async () => {
    // Baseline always returns 'hello world'; variant returns synonyms
    // that score high vs reference but low vs baseline output. The
    // pairwise mode catches this where vs_historical wouldn't.
    const adapter = makeAdapter(({ system }) => {
      if (system === "baseline") return "hello world";
      return "hi earth";
    });
    const result = await comparePrompts({
      baselinePrompt: "baseline",
      variantPrompt: "variant",
      dataset: [exampleA],
      mode: "pairwise",
      adapter,
    });
    expect(result.mode).toBe("pairwise");
    // Pairwise self-similarity is < 1, so passed should be false at
    // the default 0.02 tolerance.
    expect(result.passed).toBe(false);
    expect(result.delta).toBeLessThan(0);
  });

  it("returns passed=true with empty dataset (degenerate)", async () => {
    const adapter = makeAdapter(() => "");
    const result = await comparePrompts({
      baselinePrompt: "p1",
      variantPrompt: "p2",
      dataset: [],
      adapter,
    });
    expect(result.examplesScored).toBe(0);
    expect(result.passed).toBe(true);
  });

  it("formatComparisonSummary renders a single-line CLI summary", async () => {
    const adapter = makeAdapter(({ user }) =>
      user.includes("english") ? "hello world" : "hola mundo",
    );
    const result = await comparePrompts({
      baselinePrompt: "baseline",
      variantPrompt: "variant",
      dataset: [exampleA, exampleB],
      adapter,
    });
    const summary = formatComparisonSummary(result);
    expect(summary).toContain("PASS");
    expect(summary).toContain("n=2");
    expect(summary).toContain("baseline=");
    expect(summary).toContain("variant=");
    expect(summary).toContain("delta=");
  });

  it("requires runtime or adapter when neither is provided", async () => {
    // resolveAdapter() short-circuits to the Cerebras training adapter
    // when TRAIN_MODEL_PROVIDER / TRAINING_PROVIDER is "cerebras" (the
    // default in repo-local .env). Clear those for the duration of this
    // test so the "neither runtime nor adapter" branch can fire.
    const originalTrainProvider = process.env.TRAIN_MODEL_PROVIDER;
    const originalTrainingProvider = process.env.TRAINING_PROVIDER;
    delete process.env.TRAIN_MODEL_PROVIDER;
    delete process.env.TRAINING_PROVIDER;
    try {
      await expect(
        comparePrompts({
          baselinePrompt: "p1",
          variantPrompt: "p2",
          dataset: [exampleA],
        }),
      ).rejects.toThrow(/runtime.*or.*adapter/i);
    } finally {
      if (originalTrainProvider !== undefined) {
        process.env.TRAIN_MODEL_PROVIDER = originalTrainProvider;
      }
      if (originalTrainingProvider !== undefined) {
        process.env.TRAINING_PROVIDER = originalTrainingProvider;
      }
    }
  });

  afterEach(() => {});
});
