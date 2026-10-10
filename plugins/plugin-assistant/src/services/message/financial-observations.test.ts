import { describe, expect, it } from "vitest";
import { evaluatePlannedReplyEgress } from "./egress-policy.ts";

const egress = (reply: string, request: string) =>
  evaluatePlannedReplyEgress({
    reply,
    request,
    actionResults: [],
    actions: [],
  });

describe("financial holding grounding", () => {
  it("does not read a currency-symbol price paid from a wallet as a held balance", () => {
    expect(
      egress(
        "the plugin settles $0.01 usdc per call from the agent's own wallet.",
        "go ahead",
      ),
    ).toEqual({ verdict: "allow" });
  });

  it("still rejects an unobserved holding", () => {
    expect(egress("You hold 12 SOL.", "what's in my wallet?")).toEqual({
      verdict: "reject",
      kind: "financial_holding",
    });
  });
});
