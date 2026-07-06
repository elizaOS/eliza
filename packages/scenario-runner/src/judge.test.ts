/**
 * Fallback judge parsing tests. These cover the runtime TEXT_LARGE path used
 * when the independent Cerebras judge is not configured, including the retry
 * loop that must throw a typed error instead of fabricating a score.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JudgeParseError, judgeTextWithLlm } from "./judge.ts";

describe("judgeTextWithLlm fallback parsing", () => {
  beforeEach(() => {
    vi.stubEnv("EVAL_MODEL_PROVIDER", "runtime");
    vi.stubEnv("CEREBRAS_API_KEY", "");
    vi.stubEnv("EVAL_CEREBRAS_API_KEY", "");
    vi.stubEnv("ELIZA_E2E_CEREBRAS_API_KEY", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("retries malformed TEXT_LARGE output and returns the first parseable verdict", async () => {
    const useModel = vi
      .fn()
      .mockResolvedValueOnce("not json")
      .mockResolvedValueOnce("still not json")
      .mockResolvedValueOnce('{"score":"0.84","reason":"rubric satisfied"}');
    const runtime = { useModel } as unknown as IAgentRuntime;

    const result = await judgeTextWithLlm(
      runtime,
      "candidate text",
      "rubric text",
    );

    expect(result).toEqual({
      score: 0.84,
      reason: "rubric satisfied",
      verdict: "PASS",
    });
    expect(useModel).toHaveBeenCalledTimes(3);
  });

  it("throws JudgeParseError after every fallback parse attempt fails", async () => {
    const useModel = vi
      .fn()
      .mockResolvedValueOnce("first malformed output")
      .mockResolvedValueOnce("second malformed output")
      .mockResolvedValueOnce("third malformed output");
    const runtime = { useModel } as unknown as IAgentRuntime;

    let thrown: unknown;
    try {
      await judgeTextWithLlm(runtime, "candidate text", "rubric text");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(JudgeParseError);
    expect(thrown).toMatchObject({
      name: "JudgeParseError",
      raw: "third malformed output",
    });
    expect(useModel).toHaveBeenCalledTimes(3);
  });
});
