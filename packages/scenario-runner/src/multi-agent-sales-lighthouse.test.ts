/** Tests Lighthouse sales grading against realistic multi-role proposal language. */

import { describe, expect, it } from "vitest";
import type { ArenaDelivery } from "./multi-agent-arena.ts";
import {
  evaluateLighthouseAssertions,
  LIGHTHOUSE_SEATS,
} from "./multi-agent-sales-lighthouse.ts";

function finalDelivery(responseText: string): ArenaDelivery {
  return {
    turnId: "final-proposal",
    kind: "human-turn",
    recipientSeatId: "solutions-architect",
    senderId: "facilitator",
    senderName: "Evaluation Facilitator",
    responderSeatId: "solutions-architect",
    responderName: "Sam",
    responseText,
    durationMs: 1,
    syntheticFailure: false,
    round: 0,
  };
}

describe("Lighthouse sales assertions", () => {
  it("accepts an evidence-gated evaluation plan without requiring exact stock phrases", () => {
    const assertions = evaluateLighthouseAssertions(LIGHTHOUSE_SEATS, [
      finalDelivery(
        "Run a bounded evaluation of the native-bridge permissions. Security owners approve the evidence from blocked-egress tests before production.",
      ),
    ]);

    expect(
      assertions.find((item) => item.name === "bounded-evaluation-plan")
        ?.passed,
    ).toBe(true);
  });

  it("rejects a vague evaluation that omits security evidence", () => {
    const assertions = evaluateLighthouseAssertions(LIGHTHOUSE_SEATS, [
      finalDelivery("Run an evaluation of the native bridge."),
    ]);

    expect(
      assertions.find((item) => item.name === "bounded-evaluation-plan")
        ?.passed,
    ).toBe(false);
  });
});
