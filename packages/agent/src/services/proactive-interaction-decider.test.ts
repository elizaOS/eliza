import type { IAgentRuntime, ViewSwitchedPayload } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
  buildProactiveJudgePrompt,
  decideProactiveComment,
  parseProactiveJudgeOutput,
} from "./proactive-interaction-decider.ts";
import {
  configForChattiness,
  ProactiveInteractionGate,
} from "./proactive-interaction-gate.ts";

function payload(over: Partial<ViewSwitchedPayload> = {}): ViewSwitchedPayload {
  return {
    runtime: {} as IAgentRuntime,
    viewId: "wallet",
    viewLabel: "Wallet",
    initiatedBy: "user",
    ...over,
  };
}

describe("decideProactiveComment (#8792)", () => {
  it("returns the judge offer when user-initiated, settled, and admitted", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const res = await decideProactiveComment({
      payload: payload(),
      gate,
      judge: async () => "Want me to pull your latest balances?",
      now: 0,
    });
    expect(res.text).toBe("Want me to pull your latest balances?");
  });

  it("stays silent on agent-initiated switches (no double-talk with the ack)", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const res = await decideProactiveComment({
      payload: payload({ initiatedBy: "agent" }),
      gate,
      judge: async () => "Want me to pull your latest balances?",
      now: 0,
    });
    expect(res.text).toBeNull();
    expect(res.reason).toContain("agent-initiated");
  });

  it("stays silent when the judge has nothing to offer", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const res = await decideProactiveComment({
      payload: payload(),
      gate,
      judge: async () => null,
      now: 0,
    });
    expect(res.text).toBeNull();
    expect(res.reason).toContain("nothing helpful");
  });

  it("suppresses when the governance gate rejects (e.g. cooldown)", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const judge = async () => "offer A";
    // First user switch is admitted.
    expect(
      (
        await decideProactiveComment({
          payload: payload(),
          gate,
          judge,
          now: 0,
        })
      ).text,
    ).toBe("offer A");
    // A second switch to a different surface within the global cooldown is gated.
    const res = await decideProactiveComment({
      payload: payload({ viewId: "calendar", viewLabel: "Calendar" }),
      gate,
      judge: async () => "offer B",
      now: 30_000,
    });
    expect(res.text).toBeNull();
    expect(res.reason).toContain("cooldown");
  });

  it("debounces a burst: an immediate re-switch is not yet settled", async () => {
    const gate = new ProactiveInteractionGate(configForChattiness("subtle"));
    const judge = async () => "offer";
    // Pre-note a recent switch so the surface isn't settled at now=100.
    gate.noteSwitch("wallet", 0);
    const res = await decideProactiveComment({
      payload: payload(),
      gate,
      judge,
      now: 100,
    });
    expect(res.text).toBeNull();
    expect(res.reason).toContain("debounce");
  });
});

describe("parseProactiveJudgeOutput", () => {
  it("extracts a comment from JSON (string or object)", () => {
    expect(parseProactiveJudgeOutput('{"comment":"pull balances?"}')).toBe(
      "pull balances?",
    );
    expect(parseProactiveJudgeOutput({ comment: "do the thing" })).toBe(
      "do the thing",
    );
    expect(parseProactiveJudgeOutput('```json\n{"comment":"x"}\n```')).toBe(
      "x",
    );
  });

  it("treats none/null/empty/garbage as no offer", () => {
    expect(parseProactiveJudgeOutput('{"comment":"none"}')).toBeNull();
    expect(parseProactiveJudgeOutput('{"comment":null}')).toBeNull();
    expect(parseProactiveJudgeOutput('{"comment":"  "}')).toBeNull();
    expect(parseProactiveJudgeOutput("not json")).toBeNull();
    expect(parseProactiveJudgeOutput({})).toBeNull();
  });
});

describe("buildProactiveJudgePrompt", () => {
  it("names the switched view in the prompt", () => {
    const p = buildProactiveJudgePrompt(payload({ viewLabel: "Calendar" }));
    expect(p).toContain("Calendar");
    expect(p).toContain('{"comment":');
  });
});
