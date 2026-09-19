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

  it("delivers rubric and candidate literally without reinterpreting inserted placeholders", async () => {
    const rubric =
      "Keep $& and $` and $' and $$ plus {candidate} and {rubric} exactly.\n  rubric tail";
    const candidate =
      "Result $& $` $' $$ {rubric} {candidate}\n  candidate tail";
    let rendered = "";
    const useModel = async (_type: string, params: { prompt: string }) => {
      rendered = params.prompt;
      return '{"score":1,"reason":"complete input"}';
    };
    await judgeTextWithLlm(
      { useModel } as unknown as IAgentRuntime,
      candidate,
      rubric,
    );
    expect(
      rendered.split("RUBRIC:\n")[1].split("\n\nRespond with ONLY")[0],
    ).toBe(`${rubric}\n\nCANDIDATE RESPONSE:\n${candidate}`);
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

    expect(result).toMatchObject({
      score: 0.84,
      reason: "rubric satisfied",
      verdict: "PASS",
      raw: '{"score":"0.84","reason":"rubric satisfied"}',
    });
    expect(result.evidence.transport).toBe("runtime");
    expect(result.evidence.prompt).toContain("candidate text");
    expect(result.evidence.prompt).toContain("rubric text");
    expect(result.evidence.attempts).toEqual([
      { raw: "not json", accepted: false },
      { raw: "still not json", accepted: false },
      { raw: '{"score":"0.84","reason":"rubric satisfied"}', accepted: true },
    ]);
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

  it.each(["0.9junk", "1e", 2, -0.1, [0.9], null, true])(
    "rejects invalid score %j through the full retry boundary",
    async (score) => {
      const raw = JSON.stringify({ score, reason: "claimed success" });
      const useModel = vi.fn().mockResolvedValue(raw);
      await expect(
        judgeTextWithLlm(
          { useModel } as unknown as IAgentRuntime,
          "candidate",
          "rubric",
        ),
      ).rejects.toMatchObject({ name: "JudgeParseError", raw });
      expect(useModel).toHaveBeenCalledTimes(3);
    },
  );

  it.each([undefined, "", "  "])(
    "rejects absent justification %j",
    async (reason) => {
      const raw = JSON.stringify({ score: 1, reason });
      const useModel = vi.fn().mockResolvedValue(raw);
      await expect(
        judgeTextWithLlm(
          { useModel } as unknown as IAgentRuntime,
          "candidate",
          "rubric",
        ),
      ).rejects.toMatchObject({ name: "JudgeParseError", raw });
    },
  );

  it("keeps the complete malformed model output in the typed error", () => {
    const distinguishingTail = "judge-output-tail";
    const raw = `${"x".repeat(1_000)}${distinguishingTail}`;
    const error = new JudgeParseError(3, raw);

    expect(error.raw).toBe(raw);
    expect(error.message).toContain(distinguishingTail);
    expect(error.message).toContain(raw);
  });
});
