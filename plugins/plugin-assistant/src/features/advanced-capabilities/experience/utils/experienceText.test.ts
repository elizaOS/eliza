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

  it("treats a decomposed copy of a learning as a duplicate", () => {
    const decomposed = KOREAN_LEARNING.normalize("NFD");
    expect(decomposed).not.toBe(KOREAN_LEARNING);
    expect(isDuplicateLearning(KOREAN_LEARNING, decomposed)).toBe(true);
  });
});

describe("experienceText opposite learnings", () => {
  const RUN_FIRST =
    "Run the database migrations before starting the API server";

  it("does not call a learning and its negation duplicates", () => {
    expect(
      isDuplicateLearning(
        RUN_FIRST,
        "Do not run the database migrations before starting the API server",
      ),
    ).toBe(false);
  });

  it("does not call a reversed learning a duplicate", () => {
    expect(
      isDuplicateLearning(
        "Use the staging token for the deploy script",
        "No longer use the staging token for the deploy script",
      ),
    ).toBe(false);
  });

  it("still merges a reworded learning with the same polarity", () => {
    expect(
      isDuplicateLearning(
        RUN_FIRST,
        "Always run the database migrations before starting the API server.",
      ),
    ).toBe(true);
  });

  // Two negations must not cancel out: "do not X and do not Y" is not "X and Y".
  it.each([
    [
      "Do not run the database migrations before starting the API server and do not restart the worker",
      "Run the database migrations before starting the API server and restart the worker",
    ],
    [
      "The agent works without coffee and without tea during the nightly build",
      "The agent works with coffee and with tea during the nightly build",
    ],
    [
      "The agent never retries a 4xx request nor logs the raw token in plaintext",
      "The agent retries a 4xx request and logs the raw token in plaintext",
    ],
  ])("does not merge a learning that negates two clauses: %s", (a, b) => {
    expect(isDuplicateLearning(a, b)).toBe(false);
  });

  it("still merges two spellings of the same negation", () => {
    expect(
      isDuplicateLearning(
        "Do not run the database migrations before starting the API server",
        "Don't run the database migrations before starting the API server",
      ),
    ).toBe(true);
  });
});
