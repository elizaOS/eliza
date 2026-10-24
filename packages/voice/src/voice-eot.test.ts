import { describe, expect, it } from "vitest";
import { scoreEndOfTurnHeuristic } from "./voice-eot.js";

describe("scoreEndOfTurnHeuristic", () => {
  it("scores a recognizer's final full stop by the words before it", () => {
    for (const text of [
      "I want to pay the.",
      "I was going to call my daughter and.",
      "Um.",
    ]) {
      expect(scoreEndOfTurnHeuristic(text), text).toBeLessThan(0.5);
      expect(scoreEndOfTurnHeuristic(text)).toBe(
        scoreEndOfTurnHeuristic(text.slice(0, -1)),
      );
    }
    expect(scoreEndOfTurnHeuristic("Turn on the lights.")).toBe(0.95);
    expect(scoreEndOfTurnHeuristic("I paid 45.")).toBe(0.95);
    expect(scoreEndOfTurnHeuristic("What time is it?")).toBe(0.95);
  });

  it("keeps listening through a trailing ellipsis", () => {
    expect(scoreEndOfTurnHeuristic("I was going to say...")).toBe(0.2);
    expect(scoreEndOfTurnHeuristic("I was going to say…")).toBe(0.2);
  });

  it("keeps listening through an unfinished number", () => {
    for (const text of [
      "The bill was 1,",
      "Send them $",
      "It came to 45 point",
      "It came to forty-five point.",
      "It came to zero point",
      "I paid two hundred.",
      "About three thousand",
      "It costs a million",
    ]) {
      expect(scoreEndOfTurnHeuristic(text), text).toBe(0.2);
    }
    expect(scoreEndOfTurnHeuristic("The bill was 1,250.")).toBe(0.95);
    for (const text of [
      "That's the point.",
      "Go to the meeting point.",
      "Add a bullet point.",
    ]) {
      expect(scoreEndOfTurnHeuristic(text), text).toBe(0.95);
    }
  });
});
