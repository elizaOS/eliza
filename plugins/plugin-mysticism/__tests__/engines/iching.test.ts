import { describe, expect, it } from "vitest";
import {
  binaryToHexagramNumber,
  castHexagram,
  getHexagram,
  getLowerTrigram,
  getTrigram,
  getUpperTrigram,
} from "../../src/engines/iching/divination";
import {
  buildHexagramPrompt,
  buildIChingSynthesisPrompt,
  buildLinePrompt,
  IChingEngine,
} from "../../src/engines/iching/index";
import type { FeedbackEntry } from "../../src/types";

// ─── Divination Core Tests ───────────────────────────────

describe("I Ching Divination", () => {
  it("castHexagram produces exactly 6 lines", () => {
    const result = castHexagram();
    expect(result.lines).toHaveLength(6);
  });

  it("all line values are 6, 7, 8, or 9", () => {
    // Run many casts to increase coverage of random outcomes
    for (let i = 0; i < 50; i++) {
      const result = castHexagram();
      for (const lineValue of result.lines) {
        expect([6, 7, 8, 9]).toContain(lineValue);
      }
    }
  });

  it("binary string is 6 characters of 0s and 1s", () => {
    for (let i = 0; i < 20; i++) {
      const result = castHexagram();
      expect(result.binary).toHaveLength(6);
      expect(result.binary).toMatch(/^[01]{6}$/);
    }
  });

  it("binary representation is consistent with line values", () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = castHexagram();
      for (let i = 0; i < 6; i++) {
        const lineValue = result.lines[i];
        // Yang (7, 9) → 1; Yin (6, 8) → 0
        const expectedBit = lineValue === 7 || lineValue === 9 ? "1" : "0";
        expect(result.binary[i]).toBe(expectedBit);
      }
    }
  });

  it("changing lines are correctly identified as positions where value is 6 or 9", () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const result = castHexagram();
      for (let pos = 0; pos < 6; pos++) {
        const isChanging = result.lines[pos] === 6 || result.lines[pos] === 9;
        const positionNumber = pos + 1; // 1-based
        if (isChanging) {
          expect(result.changingLines).toContain(positionNumber);
        } else {
          expect(result.changingLines).not.toContain(positionNumber);
        }
      }
    }
  });

  it("transformed hexagram exists when changing lines are present", () => {
    let found = false;
    for (let i = 0; i < 200; i++) {
      const result = castHexagram();
      if (result.changingLines.length > 0) {
        expect(result.transformedHexagramNumber).toBeTypeOf("number");
        expect(result.transformedHexagramNumber).toBeGreaterThanOrEqual(1);
        expect(result.transformedHexagramNumber).toBeLessThanOrEqual(64);
        expect(result.transformedBinary).toBeTypeOf("string");
        expect(result.transformedBinary!).toHaveLength(6);
        expect(result.transformedBinary!).toMatch(/^[01]{6}$/);
        found = true;
        break;
      }
    }
    // Probability of not finding one in 200 tries is vanishingly small
    expect(found).toBe(true);
  });

  it("no transformed hexagram when no changing lines exist", () => {
    let found = false;
    for (let i = 0; i < 200; i++) {
      const result = castHexagram();
      if (result.changingLines.length === 0) {
        expect(result.transformedHexagramNumber).toBeNull();
        expect(result.transformedBinary).toBeNull();
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("binaryToHexagramNumber maps 111111 to hexagram 1 (Qian / The Creative)", () => {
    const number = binaryToHexagramNumber("111111");
    expect(number).toBe(1);
    const hex = getHexagram(number);
    expect(hex.name).toBe("Qian");
  });

  it("binaryToHexagramNumber maps 000000 to hexagram 2 (Kun / The Receptive)", () => {
    const number = binaryToHexagramNumber("000000");
    expect(number).toBe(2);
    const hex = getHexagram(number);
    expect(hex.name).toBe("Kun");
  });

  it("binaryToHexagramNumber throws for invalid binary pattern", () => {
    expect(() => binaryToHexagramNumber("invalid")).toThrow();
    expect(() => binaryToHexagramNumber("1234567")).toThrow();
  });

  it("all 64 hexagrams are accessible and have required fields", () => {
    for (let num = 1; num <= 64; num++) {
      const hexagram = getHexagram(num);
      expect(hexagram.number).toBe(num);
      expect(hexagram.name).toBeTypeOf("string");
      expect(hexagram.name.length).toBeGreaterThan(0);
      expect(hexagram.englishName).toBeTypeOf("string");
      expect(hexagram.character).toBeTypeOf("string");
      expect(hexagram.binary).toHaveLength(6);
      expect(hexagram.binary).toMatch(/^[01]{6}$/);
      expect(hexagram.judgment).toBeTypeOf("string");
      expect(hexagram.image).toBeTypeOf("string");
      expect(hexagram.lines).toHaveLength(6);
      expect(hexagram.keywords.length).toBeGreaterThan(0);
      expect(hexagram.description).toBeTypeOf("string");
      expect(hexagram.topTrigram).toBeGreaterThanOrEqual(1);
      expect(hexagram.topTrigram).toBeLessThanOrEqual(8);
      expect(hexagram.bottomTrigram).toBeGreaterThanOrEqual(1);
      expect(hexagram.bottomTrigram).toBeLessThanOrEqual(8);
    }
  });

  it("all 8 trigrams are accessible and have required fields", () => {
    for (let num = 1; num <= 8; num++) {
      const trigram = getTrigram(num);
      expect(trigram.number).toBe(num);
      expect(trigram.name).toBeTypeOf("string");
      expect(trigram.name.length).toBeGreaterThan(0);
      expect(trigram.englishName).toBeTypeOf("string");
      expect(trigram.character).toBeTypeOf("string");
      expect(trigram.binary).toHaveLength(3);
      expect(trigram.binary).toMatch(/^[01]{3}$/);
      expect(trigram.lines).toHaveLength(3);
      expect(trigram.attribute).toBeTypeOf("string");
      expect(trigram.image).toBeTypeOf("string");
      expect(trigram.element).toBeTypeOf("string");
    }
  });

  it("getHexagram throws for out-of-range hexagram numbers", () => {
    expect(() => getHexagram(0)).toThrow();
    expect(() => getHexagram(65)).toThrow();
    expect(() => getHexagram(-1)).toThrow();
  });

  it("getTrigram throws for out-of-range trigram numbers", () => {
    expect(() => getTrigram(0)).toThrow();
    expect(() => getTrigram(9)).toThrow();
    expect(() => getTrigram(-1)).toThrow();
  });

  it("getLowerTrigram and getUpperTrigram return valid trigrams", () => {
    // Hexagram 1 (Qian) has both trigrams as Qian (trigram 1)
    const hex1 = getHexagram(1);
    const lower1 = getLowerTrigram(hex1);
    const upper1 = getUpperTrigram(hex1);
    expect(lower1.number).toBe(hex1.bottomTrigram);
    expect(upper1.number).toBe(hex1.topTrigram);
    expect(lower1.name).toBeTypeOf("string");
    expect(upper1.name).toBeTypeOf("string");

    // Verify for a different hexagram with distinct trigrams
    const hex11 = getHexagram(11); // Tai — Earth over Heaven
    const lower11 = getLowerTrigram(hex11);
    const upper11 = getUpperTrigram(hex11);
    expect(lower11.number).toBe(hex11.bottomTrigram);
    expect(upper11.number).toBe(hex11.topTrigram);
  });

  it("every hexagram binary maps back to its own number through binaryToHexagramNumber", () => {
    for (let num = 1; num <= 64; num++) {
      const hex = getHexagram(num);
      const mappedNumber = binaryToHexagramNumber(hex.binary);
      expect(mappedNumber).toBe(num);
    }
  });

  it("hexagram lines have position, text, and meaning fields", () => {
    const hex = getHexagram(1);
    for (const line of hex.lines) {
      expect(line.position).toBeTypeOf("number");
      expect(line.position).toBeGreaterThanOrEqual(1);
      expect(line.position).toBeLessThanOrEqual(6);
      expect(line.text).toBeTypeOf("string");
      expect(line.text.length).toBeGreaterThan(0);
      expect(line.meaning).toBeTypeOf("string");
      expect(line.meaning.length).toBeGreaterThan(0);
    }
  });
});

// ─── IChingEngine Tests ──────────────────────────────────

describe("IChingEngine", () => {
  const engine = new IChingEngine();

  it("startReading creates valid state with hexagram and cast result", () => {
    const state = engine.startReading("What path should I take?");
    expect(state.question).toBe("What path should I take?");
    expect(state.castResult).toBeDefined();
    expect(state.castResult.lines).toHaveLength(6);
    expect(state.castResult.binary).toHaveLength(6);
    expect(state.hexagram).toBeDefined();
    expect(state.hexagram.number).toBeGreaterThanOrEqual(1);
    expect(state.hexagram.number).toBeLessThanOrEqual(64);
    expect(state.revealedLines).toBe(0);
    expect(state.userFeedback).toHaveLength(0);

    // If changing lines exist, transformed hexagram should be present
    if (state.castResult.changingLines.length > 0) {
      expect(state.transformedHexagram).not.toBeNull();
      expect(state.transformedHexagram?.number).toBeGreaterThanOrEqual(1);
    } else {
      expect(state.transformedHexagram).toBeNull();
    }
  });

  it("getNextReveal reveals changing lines in bottom-to-top order", () => {
    // Find a reading with at least 2 changing lines
    let tested = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = engine.startReading("test question");
      if (state.castResult.changingLines.length >= 2) {
        const sortedChanging = [...state.castResult.changingLines].sort((a, b) => a - b);

        const reveal1 = engine.getNextReveal(state);
        expect(reveal1).not.toBeNull();
        expect(reveal1?.linePosition).toBe(sortedChanging[0]);
        expect(reveal1?.prompt).toBeTypeOf("string");
        expect(reveal1?.prompt.length).toBeGreaterThan(50);
        tested = true;
        break;
      }
    }
    expect(tested).toBe(true);
  });

  it("getNextReveal returns null when no changing lines exist", () => {
    let tested = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const state = engine.startReading("test");
      if (state.castResult.changingLines.length === 0) {
        const reveal = engine.getNextReveal(state);
        expect(reveal).toBeNull();
        tested = true;
        break;
      }
    }
    expect(tested).toBe(true);
  });

  it("recordFeedback increments revealedLines and stores feedback immutably", () => {
    const state = engine.startReading("test");
    const feedback: FeedbackEntry = {
      element: "hexagram",
      userText: "This makes sense to me",
      timestamp: Date.now(),
    };

    const updated = engine.recordFeedback(state, feedback);
    expect(updated.revealedLines).toBe(1);
    expect(updated.userFeedback).toHaveLength(1);
    expect(updated.userFeedback[0].element).toBe("hexagram");

    // Original state unchanged (immutability)
    expect(state.revealedLines).toBe(0);
    expect(state.userFeedback).toHaveLength(0);
  });

  it("getSynthesis returns a substantive prompt string", () => {
    const state = engine.startReading("What guidance is offered?");
    const synthesis = engine.getSynthesis(state);
    expect(synthesis).toBeTypeOf("string");
    expect(synthesis.length).toBeGreaterThan(100);
    expect(synthesis).toContain("What guidance is offered?");
    expect(synthesis).toContain(state.hexagram.name);
  });
});

// ─── Statistical Distribution Tests ─────────────────────

describe("Statistical Distribution", () => {
  it("line values approximate expected three-coin method probabilities over many casts", () => {
    const counts: Record<number, number> = { 6: 0, 7: 0, 8: 0, 9: 0 };
    const totalCasts = 500;
    const totalLines = totalCasts * 6; // 3000 lines

    for (let i = 0; i < totalCasts; i++) {
      const result = castHexagram();
      for (const lineValue of result.lines) {
        counts[lineValue]++;
      }
    }

    // All four values must appear
    expect(counts[6]).toBeGreaterThan(0);
    expect(counts[7]).toBeGreaterThan(0);
    expect(counts[8]).toBeGreaterThan(0);
    expect(counts[9]).toBeGreaterThan(0);

    // Expected probabilities (three-coin method):
    //   6 (Old Yin)   = 1/8 = 12.5%
    //   7 (Young Yang) = 3/8 = 37.5%
    //   8 (Young Yin)  = 3/8 = 37.5%
    //   9 (Old Yang)   = 1/8 = 12.5%
    // Use generous bounds (±10 pp) for test stability
    const p6 = counts[6] / totalLines;
    const p7 = counts[7] / totalLines;
    const p8 = counts[8] / totalLines;
    const p9 = counts[9] / totalLines;

    // Old Yin / Old Yang: ~12.5%, accept 5%-22%
    expect(p6).toBeGreaterThan(0.05);
    expect(p6).toBeLessThan(0.22);
    expect(p9).toBeGreaterThan(0.05);
    expect(p9).toBeLessThan(0.22);

    // Young Yang / Young Yin: ~37.5%, accept 25%-50%
    expect(p7).toBeGreaterThan(0.25);
    expect(p7).toBeLessThan(0.5);
    expect(p8).toBeGreaterThan(0.25);
    expect(p8).toBeLessThan(0.5);

    // Changing lines (6 + 9) should be ~25%, accept 15%-35%
    const changingRate = (counts[6] + counts[9]) / totalLines;
    expect(changingRate).toBeGreaterThan(0.15);
    expect(changingRate).toBeLessThan(0.35);
  });
});

// ─── Hexagram Data Integrity Tests ───────────

describe("Hexagram Data Integrity", () => {
  const allHexagrams = Array.from({ length: 64 }, (_, i) => getHexagram(i + 1));

  it("all 64 hexagram binaries are unique", () => {
    const binaries = allHexagrams.map((h) => h.binary);
    const unique = new Set(binaries);
    expect(unique.size).toBe(64);
  });

  it("each hexagram's topTrigram and bottomTrigram are valid (1-8)", () => {
    for (const hex of allHexagrams) {
      expect(hex.topTrigram).toBeGreaterThanOrEqual(1);
      expect(hex.topTrigram).toBeLessThanOrEqual(8);
      expect(hex.bottomTrigram).toBeGreaterThanOrEqual(1);
      expect(hex.bottomTrigram).toBeLessThanOrEqual(8);
    }
  });

  it("all hexagram characters are unique Unicode characters", () => {
    const chars = allHexagrams.map((h) => h.character);
    const unique = new Set(chars);
    expect(unique.size).toBe(64);
  });

  it("each hexagram has exactly 6 lines with positions 1-6", () => {
    for (const hex of allHexagrams) {
      expect(hex.lines).toHaveLength(6);
      const positions = hex.lines.map((l) => l.position).sort((a, b) => a - b);
      expect(positions).toEqual([1, 2, 3, 4, 5, 6]);
    }
  });

  it("each hexagram has at least 3 keywords", () => {
    for (const hex of allHexagrams) {
      expect(hex.keywords.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("hexagram judgment and image texts are non-empty (> 10 chars)", () => {
    for (const hex of allHexagrams) {
      expect(hex.judgment.length).toBeGreaterThan(10);
      expect(hex.image.length).toBeGreaterThan(10);
    }
  });

  it("each hexagram's binary matches its trigram composition: lower 3 bits = bottomTrigram binary, upper 3 bits = topTrigram binary", () => {
    for (const hex of allHexagrams) {
      const bottom = getTrigram(hex.bottomTrigram);
      const top = getTrigram(hex.topTrigram);
      expect(hex.binary.slice(0, 3)).toBe(bottom.binary);
      expect(hex.binary.slice(3, 6)).toBe(top.binary);
    }
  });
});

// ─── Interpreter Prompt Tests ────────────────

describe("I Ching Interpreter Prompts", () => {
  const hex1 = getHexagram(1); // Qian
  const hex2 = getHexagram(2); // Kun
  const question = "What is the best path forward?";
  const emptyFeedback: FeedbackEntry[] = [];

  it("buildHexagramPrompt includes hexagram name and question", () => {
    const prompt = buildHexagramPrompt(hex1, question, [], null, 0, emptyFeedback);
    expect(prompt).toContain(hex1.name);
    expect(prompt).toContain(question);
  });

  it("buildHexagramPrompt includes judgment text", () => {
    const prompt = buildHexagramPrompt(hex1, question, [], null, 0, emptyFeedback);
    expect(prompt).toContain(hex1.judgment);
  });

  it("buildLinePrompt includes the line position number and line text", () => {
    const line3 = hex1.lines.find((l) => l.position === 3)!;
    const prompt = buildLinePrompt(hex1, 3, question, emptyFeedback);
    expect(prompt).toContain("3");
    expect(prompt).toContain(line3.text);
  });

  it("buildIChingSynthesisPrompt includes hexagram name", () => {
    const prompt = buildIChingSynthesisPrompt(hex1, null, [], question, emptyFeedback);
    expect(prompt).toContain(hex1.name);
  });

  it("buildIChingSynthesisPrompt includes transformed hexagram name when present", () => {
    const prompt = buildIChingSynthesisPrompt(hex1, hex2, [1, 2], question, emptyFeedback);
    expect(prompt).toContain(hex2.name);
  });

  it("prompts with feedback include feedback text", () => {
    const feedback: FeedbackEntry[] = [
      {
        element: "hexagram",
        userText: "This deeply speaks to my situation",
        timestamp: Date.now(),
      },
    ];

    const hexPrompt = buildHexagramPrompt(hex1, question, [], null, 1, feedback);
    expect(hexPrompt).toContain("This deeply speaks to my situation");

    const linePrompt = buildLinePrompt(hex1, 1, question, feedback);
    expect(linePrompt).toContain("This deeply speaks to my situation");

    const synthPrompt = buildIChingSynthesisPrompt(hex1, null, [], question, feedback);
    expect(synthPrompt).toContain("This deeply speaks to my situation");
  });
});

// ─── Engine Edge Cases ───────────────────────

describe("IChingEngine Edge Cases", () => {
  const engine = new IChingEngine();

  it("getCastingSummary returns string containing hexagram name", () => {
    const state = engine.startReading("test question");
    const summary = engine.getCastingSummary(state);
    expect(summary).toContain(state.hexagram.name);
  });

  it("getCastingSummary mentions 'Changing lines' when they exist", () => {
    let found = false;
    for (let i = 0; i < 200; i++) {
      const state = engine.startReading("test");
      if (state.castResult.changingLines.length > 0) {
        const summary = engine.getCastingSummary(state);
        expect(summary).toContain("Changing lines");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("getCastingSummary mentions 'stable' when no changing lines", () => {
    let found = false;
    for (let i = 0; i < 200; i++) {
      const state = engine.startReading("test");
      if (state.castResult.changingLines.length === 0) {
        const summary = engine.getCastingSummary(state);
        expect(summary).toContain("stable");
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("getHexagramPrompt returns a prompt containing the hexagram name", () => {
    const state = engine.startReading("What should I focus on?");
    const prompt = engine.getHexagramPrompt(state);
    expect(prompt).toContain(state.hexagram.name);
  });

  it("full reading lifecycle: start -> reveal all changing lines -> feedback -> synthesize", () => {
    // Find a reading with changing lines for a complete lifecycle test
    let tested = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = engine.startReading("How should I approach this challenge?");
      if (state.castResult.changingLines.length >= 1) {
        let currentState = state;

        // Reveal each changing line and record feedback
        let reveal = engine.getNextReveal(currentState);
        let revealCount = 0;
        while (reveal !== null) {
          expect(reveal.linePosition).toBeGreaterThanOrEqual(1);
          expect(reveal.linePosition).toBeLessThanOrEqual(6);
          expect(reveal.prompt.length).toBeGreaterThan(50);

          const feedback: FeedbackEntry = {
            element: `line_${reveal.linePosition}`,
            userText: `Line ${reveal.linePosition} resonates with me`,
            timestamp: Date.now(),
          };
          currentState = engine.recordFeedback(currentState, feedback);
          revealCount++;
          reveal = engine.getNextReveal(currentState);
        }

        // Should have revealed all changing lines
        expect(revealCount).toBe(state.castResult.changingLines.length);
        expect(currentState.userFeedback).toHaveLength(revealCount);

        // Synthesize
        const synthesis = engine.getSynthesis(currentState);
        expect(synthesis).toBeTypeOf("string");
        expect(synthesis.length).toBeGreaterThan(100);
        expect(synthesis).toContain(state.hexagram.name);

        tested = true;
        break;
      }
    }
    expect(tested).toBe(true);
  });
});
