/**
 * Unit coverage for wake-name matching: normalization, Levenshtein tolerance, and
 * wake-phrase detection. Pure functions, no mic.
 */
import { describe, expect, it } from "vitest";
import {
  isWakePhrase,
  levenshtein,
  matchWakeName,
  normalizeForWake,
} from "./wake-name-match";

describe("normalizeForWake", () => {
  it("lowercases, strips punctuation and accents, collapses whitespace", () => {
    expect(normalizeForWake("  Hey,  Éliza!! ")).toBe("hey eliza");
    expect(normalizeForWake("OK—Ada?")).toBe("ok ada");
  });
});

describe("levenshtein", () => {
  it("computes edit distance", () => {
    expect(levenshtein("eliza", "eliza")).toBe(0);
    expect(levenshtein("eliza", "elisa")).toBe(1);
    expect(levenshtein("eliza", "aliza")).toBe(1);
    expect(levenshtein("", "abc")).toBe(3);
  });
});

describe("matchWakeName", () => {
  it("matches 'hey <name>' exactly and extracts the command", () => {
    const m = matchWakeName("hey eliza what's the weather", "eliza");
    expect(m.matched).toBe(true);
    expect(m.command).toBe("what s the weather");
    expect(m.distance).toBe(0);
  });

  it("matches a bare distinctive name", () => {
    expect(matchWakeName("eliza turn on the lights", "eliza").matched).toBe(
      true,
    );
  });

  it("matches with punctuation and casing", () => {
    expect(matchWakeName("Hey, Eliza!", "eliza").matched).toBe(true);
    expect(matchWakeName("ok eliza", "eliza").matched).toBe(true);
    expect(matchWakeName("yo eliza", "eliza").matched).toBe(true);
  });

  it("tolerates ASR slop / homophones within budget", () => {
    expect(matchWakeName("hey elisa", "eliza").matched).toBe(true); // z↔s
    expect(matchWakeName("hey eliza", "aliza").matched).toBe(true); // e↔a (dist 1)
    expect(matchWakeName("hey elizah", "eliza").matched).toBe(true); // trailing h
    expect(matchWakeName("hey banana", "eliza").matched).toBe(false); // unrelated
  });

  it("follows a renamed character", () => {
    expect(matchWakeName("hey ada are you there", "ada").command).toBe(
      "are you there",
    );
    expect(matchWakeName("hey ada", "eliza").matched).toBe(false);
  });

  it("supports multi-token names", () => {
    const m = matchWakeName("hey iron man status report", "iron man");
    expect(m.matched).toBe(true);
    expect(m.command).toBe("status report");
  });

  it("matches the name mid-utterance (Swabble-style)", () => {
    expect(
      matchWakeName("so anyway hey eliza play some music", "eliza").command,
    ).toBe("play some music");
  });

  it("rejects unrelated phrases", () => {
    expect(matchWakeName("hey there how are you", "eliza").matched).toBe(false);
    expect(matchWakeName("the police arrived", "eliza").matched).toBe(false);
    expect(matchWakeName("", "eliza").matched).toBe(false);
    expect(matchWakeName("hey eliza", "").matched).toBe(false);
  });

  it("rejects a short bare name without a prefix (false-positive guard)", () => {
    // "al" is too short to count bare; needs a prefix.
    expect(matchWakeName("the alley was dark", "al").matched).toBe(false);
    expect(matchWakeName("hey al", "al").matched).toBe(true);
  });

  it("honors requirePrefix", () => {
    expect(
      matchWakeName("eliza hello", "eliza", { requirePrefix: true }).matched,
    ).toBe(false);
    expect(
      matchWakeName("hey eliza hello", "eliza", { requirePrefix: true })
        .matched,
    ).toBe(true);
  });

  it("honors a custom maxDistance", () => {
    // "elizabeth" vs "eliza" is distance 4 — outside the default budget.
    expect(matchWakeName("hey elizabeth", "eliza").matched).toBe(false);
    expect(
      matchWakeName("hey elizabeth", "eliza", { maxDistance: 4 }).matched,
    ).toBe(true);
  });

  it("works for non-Latin character names (Cyrillic / Arabic)", () => {
    // Cyrillic — renamed character "Эльза".
    expect(matchWakeName("привет эльза как дела", "Эльза").matched).toBe(true);
    expect(matchWakeName("привет эльза как дела", "Эльза").command).toBe(
      "как дела",
    );
    // Wrong name does not match.
    expect(matchWakeName("привет эльза", "ада").matched).toBe(false);
    // Arabic — diacritics (harakat) are normalized away.
    expect(matchWakeName("مرحبا أليزا", "اليزا").matched).toBe(true);
  });

  it("works for space-less scripts via substring fallback (CJK / kana / hangul)", () => {
    // Japanese: "へいエリザ、てんき" — name glued to prefix + trailing command.
    const ja = matchWakeName("へいエリザ てんき", "エリザ");
    expect(ja.matched).toBe(true);
    // Korean hangul name.
    expect(matchWakeName("안녕 엘리자 도와줘", "엘리자").matched).toBe(true);
    // Chinese name as a bare token.
    expect(matchWakeName("你好 爱丽莎 今天天气", "爱丽莎").matched).toBe(true);
    // A different CJK name does not match.
    expect(matchWakeName("你好 小明", "爱丽莎").matched).toBe(false);
  });

  it("normalizeForWake preserves non-Latin letters instead of erasing them", () => {
    expect(normalizeForWake("Эльза")).toBe("эльза");
    expect(normalizeForWake("エリザ")).toBe("エリザ");
    expect(normalizeForWake("أَلِيزَا").length).toBeGreaterThan(0);
  });

  it("isWakePhrase is a boolean wrapper", () => {
    expect(isWakePhrase("hey eliza", "eliza")).toBe(true);
    expect(isWakePhrase("nope", "eliza")).toBe(false);
  });
});
