import { describe, expect, it } from "vitest";
import {
  extractExperienceKeywords,
  isDuplicateLearning,
} from "./experienceText.ts";

const KOREAN_LEARNING = "사용자는 회의 전에 녹차를 마시는 습관이 있다";
const RUSSIAN_LEARNING =
  "Пользователь пьёт зелёный чай перед утренним совещанием каждый день";
const ENGLISH_LEARNING =
  "The user drinks green tea before the morning meeting every day";

describe("experienceText non-Latin learnings", () => {
  it("treats an identical Korean learning as a duplicate", () => {
    expect(isDuplicateLearning(KOREAN_LEARNING, KOREAN_LEARNING)).toBe(true);
  });

  it("treats an identical Russian learning as a duplicate", () => {
    expect(isDuplicateLearning(RUSSIAN_LEARNING, RUSSIAN_LEARNING)).toBe(true);
  });

  it("derives searchable keywords from a Korean learning", () => {
    const keywords = extractExperienceKeywords([KOREAN_LEARNING]);
    expect(keywords).toContain("사용자는");
    expect(keywords.length).toBeGreaterThan(0);
  });

  it("keeps the English duplicate and keyword behavior unchanged", () => {
    expect(isDuplicateLearning(ENGLISH_LEARNING, ENGLISH_LEARNING)).toBe(true);
    expect(extractExperienceKeywords([ENGLISH_LEARNING])).toContain("drinks");
  });

  it("does not call different-language learnings duplicates", () => {
    expect(isDuplicateLearning(KOREAN_LEARNING, ENGLISH_LEARNING)).toBe(false);
  });
});
