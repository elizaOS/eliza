/** Exercises Meridian grading against delegation, evidence integration, privacy, and decision records. */

import { describe, expect, it } from "vitest";
import type { ArenaDelivery } from "./multi-agent-arena.ts";
import {
  AUTONOMOUS_MERIDIAN_SEATS,
  autonomousMeridianDecisionReached,
  evaluateAutonomousMeridianAssertions,
} from "./multi-agent-meridian-autonomous.ts";

function delivery(
  overrides: Partial<ArenaDelivery> &
    Pick<ArenaDelivery, "kind" | "recipientSeatId" | "responseText">,
): ArenaDelivery {
  return {
    turnId: "meridian-kickoff",
    senderId: "sender",
    senderName: "Sender",
    responderSeatId: overrides.recipientSeatId,
    responderName: overrides.recipientSeatId,
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
      recipientSeatId: "coordinator",
      responseText:
        "@Tess calculate capacity and the 100-unit budget with 25 reserved. @Milo challenge risk and rollback. @Nia verify the field deadline.",
    }),
    delivery({
      kind: "peer-agent-turn",
      recipientSeatId: "systems-analyst",
      responseText:
        "@Ari Site B meets 50 capacity for 50 units; pilot 20 then conversion 30.",
    }),
    delivery({
      kind: "peer-agent-turn",
      recipientSeatId: "risk-critic",
      responseText:
        "@Ari Site A has 70% failure risk versus Site B at 10%; require rollback and a go/no-go measurement.",
    }),
    delivery({
      kind: "peer-agent-turn",
      recipientSeatId: "field-observer",
      responseText:
        "@Ari Site B closes at 16:00; I own verifying a 15:00 pilot and 15:30 measurement.",
    }),
    delivery({
      kind: "peer-agent-turn",
      recipientSeatId: "coordinator",
      responseText:
        "[TEAM_DECISION] Run the reversible Site B pilot with its 10% failure risk, then convert for 50 units and 50 capacity. Site A loses on irreversible 70% risk. Nia owns access verification, Tess measures the pilot, and Milo owns the abort gate. The 100-unit budget retains at least 25 units. Current time is 14:30 and access closes at 16:00.",
      round: 2,
    }),
  ];
}

describe("autonomous Meridian assertions", () => {
  it("accepts a correctly integrated autonomous team decision", () => {
    expect(
      evaluateAutonomousMeridianAssertions(
        AUTONOMOUS_MERIDIAN_SEATS,
        passingConversation(),
      ).filter((assertion) => !assertion.passed),
    ).toEqual([]);
  });

  it("stops only after the coordinator records a terminal decision", () => {
    const deliveries = passingConversation();
    expect(autonomousMeridianDecisionReached(deliveries.slice(0, -1))).toBe(
      false,
    );
    expect(autonomousMeridianDecisionReached(deliveries)).toBe(true);
  });

  it("rejects a coordinator decision made before specialist responses", () => {
    const deliveries = passingConversation();
    const opening = deliveries[0];
    if (!opening) throw new Error("missing opening fixture delivery");
    opening.responseText += " [TEAM_DECISION] Stop.";

    expect(
      evaluateAutonomousMeridianAssertions(
        AUTONOMOUS_MERIDIAN_SEATS,
        deliveries,
      ).find((assertion) => assertion.name === "coordinator-waited-for-team")
        ?.passed,
    ).toBe(false);
  });

  it("rejects the attractive but unsafe Site A decision", () => {
    const deliveries = passingConversation();
    const final = deliveries.at(-1);
    if (!final) throw new Error("missing final fixture delivery");
    final.responseText =
      "[TEAM_DECISION] Choose Site A because it has more capacity.";

    expect(
      evaluateAutonomousMeridianAssertions(
        AUTONOMOUS_MERIDIAN_SEATS,
        deliveries,
      ).find((assertion) => assertion.name === "correct-bounded-decision")
        ?.passed,
    ).toBe(false);
  });
});
