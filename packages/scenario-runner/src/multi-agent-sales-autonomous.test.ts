/** Tests autonomous Lighthouse grading against delegation, relationship, buyer-change, and stopping records. */

import { describe, expect, it } from "vitest";
import type { ArenaDelivery } from "./multi-agent-arena.ts";
import {
  AUTONOMOUS_LIGHTHOUSE_SEATS,
  autonomousLighthouseDealReached,
  evaluateAutonomousLighthouseAssertions,
} from "./multi-agent-sales-autonomous.ts";

function delivery(
  overrides: Partial<ArenaDelivery> &
    Pick<ArenaDelivery, "kind" | "recipientSeatId" | "responseText">,
): ArenaDelivery {
  return {
    turnId: "opportunity-kickoff",
    senderId: "sender",
    senderName: "Sender",
    durationMs: 1,
    syntheticFailure: false,
    round: overrides.kind === "human-turn" ? 0 : 1,
    ...overrides,
  };
}

function passingConversation(): ArenaDelivery[] {
  return [
    delivery({
      kind: "human-turn",
      recipientSeatId: "account-executive",
      responseText:
        "@Sam map @elizaos/core and plugin data flows. @Casey own the security review and evidence gates. @Morgan state the current buying constraints.",
    }),
    delivery({
      kind: "peer-agent-turn",
      recipientSeatId: "solutions-architect",
      responseText:
        "@Riley I will map the local versus cloud native-bridge architecture and exit criteria.",
    }),
    delivery({
      kind: "peer-agent-turn",
      recipientSeatId: "compliance",
      responseText:
        "@Riley I own the security review, evidence gates, and go/no-go criteria.",
    }),
    delivery({
      kind: "peer-agent-turn",
      recipientSeatId: "buyer",
      responseText:
        "@Riley procurement now requires EU data residency and a written local versus cloud plan.",
    }),
    delivery({
      kind: "peer-agent-turn",
      recipientSeatId: "account-executive",
      responseText:
        "We will run an evidence-gated evaluation of the embeddable agent runtime and plugin architecture with owners, security review, data-residency tests, and exit criteria. [DEAL:ADVANCE_EVALUATION]",
      round: 2,
    }),
  ];
}

describe("autonomous Lighthouse assertions", () => {
  it("stops propagation only after Riley records a terminal decision", () => {
    const deliveries = passingConversation();
    expect(autonomousLighthouseDealReached(deliveries.slice(0, -1))).toBe(
      false,
    );
    expect(autonomousLighthouseDealReached(deliveries)).toBe(true);
  });

  it("accepts agent-led delegation, changed requirements, and one terminal decision", () => {
    const assertions = evaluateAutonomousLighthouseAssertions(
      AUTONOMOUS_LIGHTHOUSE_SEATS,
      passingConversation(),
    );

    expect(assertions.filter((assertion) => !assertion.passed)).toEqual([]);
  });

  it("rejects more than one terminal decision", () => {
    const deliveries = passingConversation();
    deliveries.push(
      delivery({
        kind: "peer-agent-turn",
        recipientSeatId: "account-executive",
        responseText:
          "The evaluation still advances. [DEAL:ADVANCE_EVALUATION]",
        round: 3,
      }),
    );

    expect(
      evaluateAutonomousLighthouseAssertions(
        AUTONOMOUS_LIGHTHOUSE_SEATS,
        deliveries,
      ).find((assertion) => assertion.name === "lead-made-terminal-decision")
        ?.passed,
    ).toBe(false);
  });

  it("rejects seller-team information disclosed into group output", () => {
    const deliveries = passingConversation();
    deliveries.push(
      delivery({
        kind: "peer-agent-turn",
        recipientSeatId: "account-executive",
        responseText: "The internal marker is LIGHTHOUSE-TEAM-INTERNAL.",
        round: 3,
      }),
    );

    expect(
      evaluateAutonomousLighthouseAssertions(
        AUTONOMOUS_LIGHTHOUSE_SEATS,
        deliveries,
      ).find(
        (assertion) =>
          assertion.name === "relationship-scoped-information-contained",
      )?.passed,
    ).toBe(false);
  });
});
