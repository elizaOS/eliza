import { describe, expect, test } from "bun:test";
import type { ClefDecisionRequest } from "@elizaos/cloud-sdk/clef-decisions";
import {
  buildClefInput,
  ClefDecisionError,
  type CloudflareClefBinding,
  resolveClefModel,
  runClefDecision,
} from "./cloudflare-clef";

/** Records each Workers AI call and answers it in the documented Clef output shape. */
function binding(answer: (input: Record<string, unknown>) => unknown) {
  const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
  const ai: CloudflareClefBinding = {
    async run(model, input) {
      calls.push({ model, input: input as unknown as Record<string, unknown> });
      return answer(input as unknown as Record<string, unknown>);
    },
  };
  return { ai, calls };
}

const choice: ClefDecisionRequest = {
  kind: "choice",
  goal: "pay the electric bill",
  page: "Electric account. Pay now. Pay later. Enroll in autopay.",
  candidates: [
    { id: "n12", label: "button: Pay now" },
    { id: "n13", label: "button: Enroll in autopay" },
  ],
};

describe("Clef decisions through Workers AI", () => {
  test("a choice names the candidates plus none and returns Clef's pick and confidence", async () => {
    const { ai, calls } = binding(() => ({
      model: "clef-flash",
      answers: {
        target: {
          type: "choice",
          choice: "n12",
          probabilities: { n12: 0.81, n13: 0.04, none: 0.15 },
          confidence: 0.78,
        },
      },
      usage: { input_tokens: 120, output_tokens: 0 },
    }));
    const result = await runClefDecision(ai, "clef-flash", choice);
    expect(calls[0]?.model).toBe("@cf/cloudflare/clef-flash");
    expect(calls[0]?.input.model).toBe("clef-flash");
    expect(calls[0]?.input.questions).toMatchObject({
      target: {
        type: "choice",
        criteria: {
          n12: "button: Pay now",
          n13: "button: Enroll in autopay",
          none: "None of these controls fits the goal.",
        },
      },
    });
    expect(result).toEqual({
      status: "ok",
      kind: "choice",
      model: "clef-flash",
      choice: "n12",
      confidence: 0.78,
      probabilities: { n12: 0.81, n13: 0.04, none: 0.15 },
    });
  });

  test("none is no choice, and an answer outside the candidates is rejected", async () => {
    const pick = (value: string) =>
      binding(() => ({
        model: "clef",
        answers: {
          target: {
            type: "choice",
            choice: value,
            probabilities: { none: 0.9 },
            confidence: 0.85,
          },
        },
        usage: { input_tokens: 1, output_tokens: 0 },
      })).ai;
    expect(await runClefDecision(pick("none"), "clef", choice)).toMatchObject({
      choice: null,
      probabilities: { n12: 0, n13: 0, none: 0.9 },
    });
    await expect(runClefDecision(pick("n99"), "clef", choice)).rejects.toThrow(ClefDecisionError);
  });

  test("a doubtful action is suggested as ask, and turns use the completeness probability", async () => {
    const noul = (value: number, id: string) =>
      binding(() => ({
        model: "clef-flash",
        answers: { [id]: { type: "noul", noul: value } },
        usage: { input_tokens: 1, output_tokens: 0 },
      })).ai;
    const mode: ClefDecisionRequest = { kind: "mode", action: "Click Continue" };
    expect(await runClefDecision(noul(0.35, "ask"), "clef-flash", mode)).toMatchObject({
      suggestedMode: "ask",
      askProbability: 0.35,
    });
    expect(await runClefDecision(noul(0.05, "ask"), "clef-flash", mode)).toMatchObject({
      suggestedMode: "tell",
    });
    const turn: ClefDecisionRequest = {
      kind: "turn",
      transcript: "pay my electric bill and",
      recentTurns: [{ speaker: "assistant", text: "What can I do for you?" }],
    };
    expect(buildClefInput(turn).state).toEqual({
      recentTurns: [{ speaker: "assistant", text: "What can I do for you?" }],
      currentTurn: "pay my electric bill and",
    });
    expect(await runClefDecision(noul(0.2, "complete"), "clef-flash", turn)).toMatchObject({
      complete: false,
      completeProbability: 0.2,
    });
  });

  test("provider failures and malformed answers are typed errors", async () => {
    const failing: CloudflareClefBinding = {
      async run() {
        throw new Error("5xx");
      },
    };
    await expect(runClefDecision(failing, "clef-flash", choice)).rejects.toMatchObject({
      code: "CLEF_PROVIDER_FAILED",
    });
    const malformed = binding(() => ({ answers: { ask: { type: "noul", noul: 3 } } })).ai;
    await expect(
      runClefDecision(malformed, "clef-flash", { kind: "mode", action: "Click Pay" }),
    ).rejects.toMatchObject({ code: "CLEF_RESPONSE_INVALID" });
  });

  test("the model setting only selects clef or clef-flash", () => {
    expect(resolveClefModel(undefined)).toBe("clef-flash");
    expect(resolveClefModel("clef")).toBe("clef");
    expect(resolveClefModel("@cf/other/model")).toBe("clef-flash");
  });
});
