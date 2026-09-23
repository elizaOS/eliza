/**
 * Stage-1 routing repair trigger: a simple-path reply that ends the turn
 * (a completed answer or a preview awaiting the user) while nonempty intents
 * still declare pending runtime work is self-contradictory and gets one
 * correction prompt; consistent decisions get none. Pure function, no runtime.
 */
import { describe, expect, it } from "vitest";
import { getStage1RoutingRepair } from "./stage1-generation.ts";

function decision(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    shouldRespond: "RESPOND",
    contexts: ["simple"],
    replyText:
      "I can add it for Friday, September 18 at 3:00 PM EDT. Can you confirm that date?",
    replyEffectStatus: "none",
    requiresTool: false,
    candidateActionNames: [],
    intents: ["Create a chiropractor appointment on Friday at 3:00 PM"],
    ...overrides,
  };
}

describe("getStage1RoutingRepair", () => {
  it.each([
    { disposition: "none", singleViewOnly: false, navigationOnly: false },
    { disposition: "requested", singleViewOnly: false, navigationOnly: true },
  ])(
    "reviews contradictory navigation fields before effects: %j",
    (visualContinuation) => {
      expect(
        getStage1RoutingRepair(
          decision({
            contexts: ["notes"],
            replyEffectStatus: "pending",
            replyText: "",
            candidateActionNames: ["VIEWS_SHOW", "NOTES_GET"],
            intents: ["open Notes", "read note"],
            visualContinuation,
          }),
        ),
      ).toContain("structured navigation declarations conflict");
    },
  );
  it.each(["forbidden", "unresolved", "requested"])(
    "does not override %s navigation with candidate hints",
    (disposition) => {
      expect(
        getStage1RoutingRepair(
          decision({
            contexts: ["notes"],
            replyEffectStatus: "pending",
            replyText: "",
            candidateActionNames: ["VIEWS_SHOW", "NOTES_GET"],
            visualContinuation: {
              disposition,
              singleViewOnly: true,
              navigationOnly: false,
            },
          }),
        ),
      ).toBeUndefined();
    },
  );

  it("repairs a completed simple answer that still declares pending intents", () => {
    expect(getStage1RoutingRepair(decision({}))).toContain(
      "response_contract_repair:",
    );
  });

  it("repairs a simple-path preview that still declares pending intents (live 2026-09-15: 'add a chiropractor appointment friday at 3pm' answered with 'Can you confirm that date?' and no calendar write)", () => {
    const repair = getStage1RoutingRepair(
      decision({ replyEffectStatus: "non_applied" }),
    );
    expect(repair).toContain("response_contract_repair:");
    expect(repair).toContain("non_applied");
    expect(repair).toContain("details the user already stated");
  });

  it("leaves consistent decisions alone", () => {
    expect(
      getStage1RoutingRepair(
        decision({ replyEffectStatus: "non_applied", intents: [] }),
      ),
    ).toBeUndefined();
    expect(getStage1RoutingRepair(decision({ intents: [] }))).toBeUndefined();
    expect(
      getStage1RoutingRepair(decision({ replyEffectStatus: "pending" })),
    ).toBeUndefined();
    expect(
      getStage1RoutingRepair(decision({ requiresTool: true })),
    ).toBeUndefined();
    expect(
      getStage1RoutingRepair(decision({ contexts: ["calendar"] })),
    ).toBeUndefined();
    expect(getStage1RoutingRepair(null)).toBeUndefined();
  });
});
