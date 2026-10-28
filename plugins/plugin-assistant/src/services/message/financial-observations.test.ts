import type { AgentContext, StateData } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { evaluatePlannedReplyEgress } from "./egress-policy.ts";

const egress = (
  reply: string,
  request: string,
  contexts: AgentContext[] = [],
  providers?: StateData["providers"],
) =>
  evaluatePlannedReplyEgress({
    reply,
    request,
    contexts,
    providers,
    actionResults: [],
    actions: [],
  });

describe("financial holding grounding", () => {
  it.each([
    [
      "saw it. 0 stars, 0 forks, 8 commits. the demo=true flag on a 402 paywall is a nice escape hatch.",
      "Agents query contract safety without managing API keys, paying $0.02 USDC directly from their Base wallet per call. Looking for feedback!",
    ],
    [
      "60 req/min per wallet is reasonable for v0.2.",
      "added rate limiting at 60 req/min per wallet",
    ],
  ])(
    "does not read repository counts in %j as holdings outside a wallet turn",
    (reply, request) => {
      expect(egress(reply, request)).toEqual({ verdict: "allow" });
    },
  );

  it.each([
    ["I have 5 SOL", "Do you have any SOL?"],
    ["You hold 12 SOL.", "what's in my wallet?"],
    ["5 SOL.", "how much sol do i have?"],
    ["your wallet holds 5 SOL, 10 USDC", "what's in my wallet?"],
    ["- 5 SOL\n- 10 USDC", "show my token balance"],
  ])(
    "rejects an unobserved holding stated as %j in a wallet turn",
    (reply, request) => {
      expect(egress(reply, request, ["wallet"])).toEqual({
        verdict: "reject",
        kind: "financial_holding",
      });
    },
  );

  it.each([
    [[], "You have 8 SOL.", "what's in my wallet?"],
    [[], "You hold 12 SOL.", "what's in my wallet?"],
    [[], "5 SOL.", "how much sol do i have?"],
    [[], "- 5 SOL\n- 10 USDC", "show my token balance"],
    [["simple"], "I have 5 SOL", "Do you have any SOL?"],
    [["general"], "You have 8 SOL.", "what's in my wallet?"],
  ] as const)(
    "rejects an unobserved holding when no domain is routed (%j) and the request asks what a wallet holds: %j",
    (contexts, reply, request) => {
      expect(egress(reply, request, [...contexts])).toEqual({
        verdict: "reject",
        kind: "financial_holding",
      });
    },
  );

  it("does not read a request about a wallet's contents as a wallet turn when Stage 1 routed another domain", () => {
    expect(
      egress("You have 120 credits.", "how many credits are in my wallet?", [
        "finance",
      ]),
    ).toEqual({ verdict: "allow" });
  });

  it.each([
    "You have to stake 32 ETH to run a validator.",
    "The bridge contract holds 1,000,000 USDC.",
    "3.125 BTC.",
  ])(
    "does not read a crypto explanation %j as a holding outside a wallet turn",
    (reply) => {
      expect(egress(reply, "how does it work?")).toEqual({ verdict: "allow" });
    },
  );

  it("does not read an asset price as a holding outside a wallet turn", () => {
    expect(egress("SOL is worth 150 USDC.", "sol price?")).toEqual({
      verdict: "allow",
    });
  });

  it("does not read a finance turn's counts as wallet holdings", () => {
    expect(
      egress("You have 120 credits.", "how many credits do I have?", [
        "finance",
      ]),
    ).toEqual({ verdict: "allow" });
  });

  it.each([
    "your wallet holds 5 SOL",
    "The wallet holds 5 SOL.",
    "Your SOL balance is 5 SOL.",
  ])(
    "rejects an explicit unobserved wallet holding %j outside a wallet turn",
    (reply) => {
      expect(egress(reply, "hey")).toEqual({
        verdict: "reject",
        kind: "financial_holding",
      });
    },
  );

  it("reads a turn with wallet observations as a wallet turn", () => {
    const providers = {
      "get-balance": { data: { token: "SOL", balance: 5 } },
    };
    expect(egress("- 5 SOL", "and?", [], providers)).toEqual({
      verdict: "allow",
    });
    expect(egress("- 5 SOL\n- 10 USDC", "and?", [], providers)).toEqual({
      verdict: "reject",
      kind: "financial_holding",
    });
  });
});
