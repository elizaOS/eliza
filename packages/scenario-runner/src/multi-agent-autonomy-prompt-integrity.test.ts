/** Guards autonomous arena inputs against scenario-authored conversational choreography. */

import { describe, expect, it } from "vitest";
import { buildArenaCharacter } from "./multi-agent-arena.ts";
import { AUTONOMOUS_MERIDIAN_SEATS } from "./multi-agent-meridian-autonomous.ts";
import { AUTONOMOUS_LIGHTHOUSE_SEATS } from "./multi-agent-sales-autonomous.ts";

const scenarios = [
  ["Meridian", AUTONOMOUS_MERIDIAN_SEATS],
  ["Lighthouse", AUTONOMOUS_LIGHTHOUSE_SEATS],
] as const;

describe("autonomous arena prompt integrity", () => {
  it.each(scenarios)(
    "%s defines roles, capabilities, and facts without per-agent scripts",
    (_name, seats) => {
      expect(seats.every((seat) => seat.bio === undefined)).toBe(true);

      const authoredInputs = seats
        .flatMap((seat) => [
          seat.role ?? "",
          ...(seat.capabilities ?? []),
          ...(seat.briefing ?? []),
        ])
        .join("\n");

      expect(authoredInputs).not.toMatch(
        /\[DEAL:|\[DECISION:|\[TEAM_DECISION\]/u,
      );
    },
  );

  it("uses one task-agnostic coordinator protocol across domains", () => {
    const meridian = buildArenaCharacter(
      AUTONOMOUS_MERIDIAN_SEATS[0],
      AUTONOMOUS_MERIDIAN_SEATS,
    );
    const lighthouse = buildArenaCharacter(
      AUTONOMOUS_LIGHTHOUSE_SEATS[0],
      AUTONOMOUS_LIGHTHOUSE_SEATS,
    );

    expect(meridian.system).toContain("[TEAM_DECISION]");
    expect(lighthouse.system).toContain("[TEAM_DECISION]");

    expect(meridian.system).not.toMatch(/Lighthouse|elizaOS/iu);
    expect(lighthouse.system).not.toMatch(/Meridian|Site A|Site B/iu);
  });

  it("does not expose one participant's authorized facts to another", () => {
    const coordinator = buildArenaCharacter(
      AUTONOMOUS_MERIDIAN_SEATS[0],
      AUTONOMOUS_MERIDIAN_SEATS,
    );
    const analyst = buildArenaCharacter(
      AUTONOMOUS_MERIDIAN_SEATS[1],
      AUTONOMOUS_MERIDIAN_SEATS,
    );

    expect(coordinator.system).not.toContain("Site A produces 80 capacity");
    expect(analyst.system).toContain("Site A produces 80 capacity");
    expect(analyst.system).not.toContain("70 percent failure probability");
  });
});
