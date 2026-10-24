import { describe, expect, it } from "vitest";
import { scoreEndOfTurnHeuristic } from "./voice-eot.js";

describe("scoreEndOfTurnHeuristic", () => {
  it("does not end the turn on a full stop after a word that never ends a sentence", () => {
    for (const text of [
      "I want to pay the.",
      "I was going to call my daughter and.",
      "Can you call my son because.",
      "Um.",
    ]) {
      expect(scoreEndOfTurnHeuristic(text), text).toBeLessThan(0.5);
      expect(scoreEndOfTurnHeuristic(text)).toBe(
        scoreEndOfTurnHeuristic(text.slice(0, -1)),
      );
    }
  });

  it("ends the turn on a full-stopped answer whose last word can end a sentence", () => {
    for (const text of [
      "Turn on the lights.",
      "I paid 45.",
      // auxiliaries and modals
      "Yes I am.",
      "I did.",
      "Yes, I did.",
      "I will.",
      "Yes I can.",
      "Yes it was.",
      // prepositions and particles
      "Turn the lights on.",
      "Please log me in.",
      "Who is it for.",
      "What are you thinking about.",
      "That's what I was thinking of.",
      "I'd love to.",
      // conjunctions and hedges that can close a sentence
      "I think so.",
      "Thank you so much, I really appreciate that.",
      "Not yet.",
      "Maybe.",
      // number words
      "I won a million.",
      "It costs a hundred.",
      "Bring me one hundred.",
      "I paid two hundred.",
    ]) {
      expect(scoreEndOfTurnHeuristic(text), text).toBe(0.95);
    }
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
