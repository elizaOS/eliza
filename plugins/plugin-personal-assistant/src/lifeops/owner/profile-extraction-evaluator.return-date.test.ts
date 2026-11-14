/**
 * An owner return date with an ordinal day must be the stored end of the trip.
 * "I'm traveling until November 21st" used to drop the date, so the trip was
 * capped at 30 days instead of November 21.
 */

import { describe, expect, it } from "vitest";
import { extractProfileDetails } from "./profile-extraction-evaluator.js";

const NOW = new Date(2026, 10, 14, 15, 0, 0);

function localDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

describe("owner travel return dates", () => {
  it("keeps an ordinal day as the return date", () => {
    const extraction = extractProfileDetails(
      "I'm traveling until November 21st.",
      NOW,
    );
    expect(extraction.travel?.kind).toBe("set");
    expect(
      extraction.travel?.kind === "set"
        ? localDate(extraction.travel.endIso)
        : undefined,
    ).toBe("2026-11-21");
  });

  it("keeps an abbreviated month with an ordinal day", () => {
    const extraction = extractProfileDetails(
      "I'm out of town until Dec 3rd.",
      NOW,
    );
    expect(
      extraction.travel?.kind === "set"
        ? localDate(extraction.travel.endIso)
        : undefined,
    ).toBe("2026-12-03");
  });

  it("still reads a date with no ordinal and an ISO date", () => {
    const prose = extractProfileDetails(
      "I'm traveling until November 21.",
      NOW,
    );
    const iso = extractProfileDetails("I'm traveling until 2026-11-21.", NOW);
    expect(
      prose.travel?.kind === "set" ? localDate(prose.travel.endIso) : undefined,
    ).toBe("2026-11-21");
    expect(
      iso.travel?.kind === "set" ? localDate(iso.travel.endIso) : undefined,
    ).toBe("2026-11-21");
  });

  it("leaves a trip with no return date unbounded by a parsed end", () => {
    const extraction = extractProfileDetails("I'm traveling.", NOW);
    expect(extraction.travel).toEqual({ kind: "set" });
  });
});
