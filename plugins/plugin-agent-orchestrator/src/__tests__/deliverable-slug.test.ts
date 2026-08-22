import { describe, expect, it } from "vitest";
import { deliverableSlugFromLabel } from "../actions/tasks.js";

describe("deliverableSlugFromLabel", () => {
  it("keeps the noun phrase and stops at the first clause boundary", () => {
    expect(
      deliverableSlugFromLabel(
        "Build a tip calculator page with input for bill amount, tip percentage, and number of people",
      ),
    ).toBe("tip-calculator-page");
    expect(
      deliverableSlugFromLabel(
        "Build a word counter page that counts words, characters, and lines",
      ),
    ).toBe("word-counter-page");
    expect(
      deliverableSlugFromLabel(
        "Build an interactive magic 8 ball page w shake animation",
      ),
    ).toBe("magic-8-ball-page");
  });

  it("passes a clean label through and never cuts inside a token", () => {
    expect(deliverableSlugFromLabel("dice-roll-page")).toBe("dice-roll-page");
    expect(deliverableSlugFromLabel("Game of Life page")).toBe(
      "game-of-life-page",
    );
    const long = deliverableSlugFromLabel(
      "extraordinarily comprehensive multiplication flashcards trainer page",
    );
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long.split("-").every((t) => t.length > 0)).toBe(true);
  });
});
