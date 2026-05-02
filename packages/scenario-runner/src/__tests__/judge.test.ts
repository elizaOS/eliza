/**
 * Unit tests for the judge JSON extractor. Exercises the brace-balanced
 * parser that replaces the earlier non-greedy regex which was truncating
 * real Groq/OpenAI judge outputs whose `reason` strings contained `}`.
 */

import { describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "@elizaos/core";
import {
  JudgeParseError,
  judgeTextWithLlm,
  type JudgeResult,
} from "../judge.ts";

type UseModelFn = IAgentRuntime["useModel"];

function makeRuntime(responses: ReadonlyArray<string>): IAgentRuntime {
  const calls: string[] = [];
  let i = 0;
  const useModel: UseModelFn = vi.fn(async () => {
    const raw = responses[Math.min(i, responses.length - 1)];
    i += 1;
    calls.push(raw);
    return raw;
  }) as unknown as UseModelFn;
  return {
    useModel,
    // @ts-expect-error test helper only needs useModel
    __calls: calls,
  };
}

describe("judge parseJudgeJson via judgeTextWithLlm", () => {
  it("parses a clean single-line JSON response", async () => {
    const runtime = makeRuntime([
      `{"score": 0.9, "reason": "Accurate and complete."}`,
    ]);
    const result: JudgeResult = await judgeTextWithLlm(
      runtime,
      "candidate",
      "rubric",
    );
    expect(result.score).toBe(0.9);
    expect(result.reason).toContain("Accurate");
  });

  it("parses JSON with a closing brace inside a string value (regression for non-greedy regex bug)", async () => {
    const runtime = makeRuntime([
      `{"score": 0.5, "reason": "Mentioned } and { edge cases."}`,
    ]);
    const result = await judgeTextWithLlm(runtime, "candidate", "rubric");
    expect(result.score).toBe(0.5);
    expect(result.reason).toBe("Mentioned } and { edge cases.");
  });

  it("parses JSON with escaped quotes in the reason", async () => {
    const runtime = makeRuntime([
      `{"score": 0.4, "reason": "Response said \\"hello\\" but missed the blockers."}`,
    ]);
    const result = await judgeTextWithLlm(runtime, "candidate", "rubric");
    expect(result.score).toBe(0.4);
    expect(result.reason).toContain('"hello"');
  });

  it("tolerates prose before and after the JSON object", async () => {
    const runtime = makeRuntime([
      `Sure, here is my evaluation:\n{"score": 0.7, "reason": "Mostly right"}\nLet me know if you need more.`,
    ]);
    const result = await judgeTextWithLlm(runtime, "candidate", "rubric");
    expect(result.score).toBe(0.7);
  });

  it("retries and succeeds when first response is empty", async () => {
    const runtime = makeRuntime([
      "",
      `{"score": 0.3, "reason": "Partial match"}`,
    ]);
    const result = await judgeTextWithLlm(runtime, "candidate", "rubric");
    expect(result.score).toBe(0.3);
  });

  it("retries twice and surfaces JudgeParseError on persistent failure", async () => {
    const runtime = makeRuntime(["no json at all", "still nothing", "nope"]);
    await expect(
      judgeTextWithLlm(runtime, "candidate", "rubric"),
    ).rejects.toBeInstanceOf(JudgeParseError);
  });

  it("clamps scores outside [0,1]", async () => {
    const runtime1 = makeRuntime([`{"score": 1.5, "reason": "x"}`]);
    const r1 = await judgeTextWithLlm(runtime1, "c", "r");
    expect(r1.score).toBe(1);

    const runtime2 = makeRuntime([`{"score": -0.3, "reason": "x"}`]);
    const r2 = await judgeTextWithLlm(runtime2, "c", "r");
    expect(r2.score).toBe(0);

    const runtime3 = makeRuntime([`{"score": "not a number", "reason": "x"}`]);
    // should retry & eventually throw because score fails Number.isFinite
    await expect(judgeTextWithLlm(runtime3, "c", "r")).rejects.toBeInstanceOf(
      JudgeParseError,
    );
  });
});
