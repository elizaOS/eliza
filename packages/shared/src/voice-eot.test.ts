/**
 * Tests the canonical end-of-turn scoring heuristic (scoreEndOfTurnHeuristic):
 * the ordered rule table (trail-off, sentence-final punctuation, question tags,
 * conjunctions/prepositions, short utterances, neutral fallback), rule ordering,
 * and that scores stay finite within [0,1] on adversarial input. Pure function.
 */
import { describe, expect, it } from "vitest";
import { scoreEndOfTurnHeuristic as score } from "./voice-eot";

describe("scoreEndOfTurnHeuristic — canonical heuristic", () => {
  it("rule 1: trailing ellipsis → trail-off (0.2)", () => {
    expect(score("so i was thinking...")).toBe(0.2);
    expect(score("hmm…")).toBe(0.2);
    expect(score("wait..")).toBe(0.2);
  });

  it("rule 2: sentence-final punctuation → complete (0.95)", () => {
    expect(score("what time is it?")).toBe(0.95);
    expect(score("set a reminder.")).toBe(0.95);
    expect(score("stop!")).toBe(0.95);
  });

  it("rule 3: question-tag suffix → complete (0.85), bare and punctuated", () => {
    // Punctuated tags fall to rule 2 first; bare tags exercise rule 3.
    expect(score("that's correct right")).toBe(0.85);
    expect(score("it is ready yeah")).toBe(0.85);
    expect(score("that makes sense correct")).toBe(0.85);
    expect(score("that's correct, right")).toBe(0.85);
    expect(score("right")).toBe(0.85);
  });

  it("rule 3 matches a bare tag only as a whole final word, never as a suffix", () => {
    // "incorrect" ends in "correct" and "alright"/"copyright" end in "right";
    // a suffix match would commit these ordinary statements at 0.85.
    expect(score("no that is incorrect")).toBe(0.5);
    expect(score("i still need the copyright")).toBe(0.5);
    expect(score("it turned out alright in the end")).toBe(0.5);
    expect(score("that was downright rude of them")).toBe(0.5);
    // A short utterance ending in such a word falls to the short-command rule.
    expect(score("alright")).toBe(0.7);
    expect(score("not incorrect")).toBe(0.7);
  });

  it("rule 4: trailing conjunction → mid-clause (0.15)", () => {
    expect(score("buy milk and")).toBe(0.15);
    expect(score("i can't do that because")).toBe(0.15);
    expect(score("i went to the store but")).toBe(0.15);
  });

  it("rule 6: trailing preposition/article → incomplete NP (0.2)", () => {
    expect(score("schedule a meeting with")).toBe(0.2);
    expect(score("put it on the")).toBe(0.2);
    expect(score("i need a")).toBe(0.2);
  });

  it("rule 5: trailing filler or hedge → tail-off hold (0.2)", () => {
    expect(score("let me think um")).toBe(0.2);
    expect(score("i was going to say uh")).toBe(0.2);
    expect(score("we could do maybe")).toBe(0.2);
  });

  it("rule 7: dangling modal/auxiliary → incomplete clause (0.2)", () => {
    expect(score("i was thinking we could")).toBe(0.2);
    expect(score("the thing is")).toBe(0.2);
    expect(score("what i would")).toBe(0.2);
  });

  it("rule 8: short utterance with no trail-off → complete (0.7)", () => {
    expect(score("go home")).toBe(0.7);
    expect(score("yes")).toBe(0.7);
    expect(score("no thanks")).toBe(0.7);
  });

  it("rule 9: no signal → neutral (0.5)", () => {
    expect(score("tell me about the weather in london")).toBe(0.5);
    expect(score("buy milk and eggs")).toBe(0.5);
  });

  it("conjunction/preposition checks precede the short-utterance rule (ordering fix)", () => {
    // A 2-word trail-off must NOT be misread as a complete short command.
    expect(score("and so")).toBe(0.15); // trailing conjunction, not 0.7
    expect(score("going to")).toBe(0.2); // trailing preposition, not 0.7
    expect(score("set the")).toBe(0.2); // trailing article, not 0.7
    expect(score("maybe uh")).toBe(0.2); // trailing filler, not 0.7
    expect(score("we could")).toBe(0.2); // dangling modal, not 0.7
  });

  it("sentence-final punctuation still commits within budget", () => {
    expect(score("let me think um.")).toBe(0.95);
    expect(score("we could do that.")).toBe(0.95);
  });

  it("empty / whitespace → neutral (0.5)", () => {
    expect(score("")).toBe(0.5);
    expect(score("   ")).toBe(0.5);
  });

  it("never throws and stays in [0,1] for adversarial input", () => {
    for (const junk of [
      "",
      "   ",
      "...",
      "?!",
      "\n\t",
      "—",
      "123 456",
      "😀😀",
      "你好吗",
    ]) {
      const s = score(junk);
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});
