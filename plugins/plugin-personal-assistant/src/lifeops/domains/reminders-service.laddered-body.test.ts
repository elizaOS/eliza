/**
 * Owner-facing surfacing of the laddered progression rung (#12284 item 10).
 * No runtime graph: exercises the pure reminder-body builder and its rung
 * reader directly, asserting the reminder leads with the small current-rung
 * step rather than the raw task title.
 */
import { describe, expect, it } from "vitest";
import { buildReminderBody, readLadderRungTitle } from "./reminders-service.ts";

const ladderRungTarget = {
  kind: "laddered",
  metric: "pages_read",
  rung: 0,
  rungTitle: "Read one page",
  rungsTotal: 3,
  unit: null,
  completedCountBefore: 0,
} satisfies Record<string, unknown>;

describe("readLadderRungTitle", () => {
  it("extracts the rung title from a laddered derived target", () => {
    expect(readLadderRungTitle(ladderRungTarget)).toBe("Read one page");
  });

  it("returns null for non-laddered / absent targets", () => {
    expect(readLadderRungTitle(null)).toBeNull();
    expect(readLadderRungTitle(undefined)).toBeNull();
    expect(
      readLadderRungTitle({ kind: "linear_increment", target: 3 }),
    ).toBeNull();
    expect(
      readLadderRungTitle({ kind: "laddered", rungTitle: "  " }),
    ).toBeNull();
  });
});

describe("buildReminderBody — laddered rung surfacing", () => {
  it("leads with the rung step rather than the raw task title", () => {
    const body = buildReminderBody({
      title: "Read the book",
      derivedTarget: ladderRungTarget,
    });
    expect(body).toBe("Read one page");
    expect(body).not.toContain("Read the book");
  });

  it("falls back to the raw title when there is no laddered target", () => {
    const body = buildReminderBody({
      title: "Read the book",
      derivedTarget: null,
    });
    expect(body).toBe("Read the book");
  });
});
