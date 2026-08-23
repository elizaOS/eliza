/**
 * Exercises database-requirement detection. The stateless list is an early
 * exit that overrides every later signal, so it must not fire on a word it
 * merely appears inside — "demographic" is not "demo". Also pins the documented
 * confidence ladder and the keyword-count thresholds. Pure module, no harness.
 */

import { describe, expect, test } from "bun:test";
import { analyzePrompt, getDetailedAnalysis, requiresDatabase } from "./stateful-detection";

describe("stateless early exit", () => {
  test("fires on a genuine stateless app", () => {
    for (const prompt of [
      "a simple calculator",
      "a unit converter",
      "a landing page for my band",
      "a countdown to launch day",
      "a weather widget",
    ]) {
      const result = analyzePrompt(prompt);
      expect(result.requiresDatabase).toBe(false);
      expect(result.confidence).toBe(0.9);
    }
  });

  test("does not fire on a word that merely contains an indicator", () => {
    const cases: Array<[string, string]> = [
      ["an app to track demographic data for my research", "demo"],
      ["a CRM to manage embedded device inventory", "embed"],
      ["a tool to log clockwise rotations of my machines", "clock"],
    ];
    for (const [prompt, substring] of cases) {
      expect(prompt.toLowerCase()).toContain(substring);
      expect(requiresDatabase(prompt)).toBe(true);
    }
  });

  test("a substring collision does not suppress a strong phrase match", () => {
    const result = analyzePrompt("a habit tracker for my demographic study group");
    expect(result.requiresDatabase).toBe(true);
    expect(result.matchedPhrases).toContain("habit tracker");
    expect(result.confidence).toBe(0.95);
  });

  test("still matches an indicator standing as its own word", () => {
    expect(requiresDatabase("a demo of my portfolio tracker")).toBe(false);
    expect(requiresDatabase("an embed for my notes dashboard")).toBe(false);
  });

  test("matches a multi-word stateless indicator", () => {
    expect(requiresDatabase("a coming soon splash page")).toBe(false);
    expect(requiresDatabase("an api proxy for my data")).toBe(false);
  });
});

describe("strong phrase matches", () => {
  test("a single phrase is enough, at the documented confidence", () => {
    for (const prompt of [
      "I want to keep track of my running",
      "an app with user accounts",
      "a shopping cart for my store",
      "somewhere to write journal entries",
    ]) {
      const result = analyzePrompt(prompt);
      expect(result.requiresDatabase).toBe(true);
      expect(result.confidence).toBe(0.95);
      expect(result.matchedPhrases.length).toBeGreaterThan(0);
    }
  });

  test("reports every phrase it matched", () => {
    const result = analyzePrompt("a todo list with a shopping cart");
    expect(result.matchedPhrases).toContain("todo list");
    expect(result.matchedPhrases).toContain("shopping cart");
  });
});

describe("keyword thresholds", () => {
  test("one keyword is not enough", () => {
    const result = analyzePrompt("something to add numbers");
    expect(result.matchedIndicators).toEqual(["add"]);
    expect(result.requiresDatabase).toBe(false);
    expect(result.confidence).toBe(0.6);
  });

  test("zero keywords is not enough", () => {
    const result = analyzePrompt("a page about volcanoes");
    expect(result.matchedIndicators).toEqual([]);
    expect(result.requiresDatabase).toBe(false);
    expect(result.confidence).toBe(0.6);
  });

  test("two keywords cross the threshold at lower confidence", () => {
    const result = analyzePrompt("edit and delete rows");
    expect(result.matchedIndicators.length).toBe(2);
    expect(result.requiresDatabase).toBe(true);
    expect(result.confidence).toBe(0.7);
  });

  test("three or more keywords raise confidence", () => {
    const result = analyzePrompt("create, edit and delete my records");
    expect(result.matchedIndicators.length).toBeGreaterThanOrEqual(3);
    expect(result.requiresDatabase).toBe(true);
    expect(result.confidence).toBe(0.85);
  });

  test("keywords match on word boundaries, not substrings", () => {
    // "additional" contains "add"; "listen" contains "list".
    const result = analyzePrompt("additional information for listeners");
    expect(result.matchedIndicators).toEqual([]);
    expect(result.requiresDatabase).toBe(false);
  });

  test("is case-insensitive", () => {
    expect(requiresDatabase("CREATE, EDIT AND DELETE MY RECORDS")).toBe(true);
    expect(analyzePrompt("A Simple CALCULATOR").requiresDatabase).toBe(false);
  });
});

describe("result shape", () => {
  test("confidence is always a probability", () => {
    for (const prompt of [
      "",
      "a calculator",
      "keep track of my habits",
      "add edit delete",
      "a page about volcanoes",
    ]) {
      const { confidence } = analyzePrompt(prompt);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  test("an empty prompt requires no database", () => {
    const result = analyzePrompt("");
    expect(result.requiresDatabase).toBe(false);
    expect(result.matchedIndicators).toEqual([]);
    expect(result.matchedPhrases).toEqual([]);
  });

  test("requiresDatabase agrees with analyzePrompt", () => {
    for (const prompt of [
      "a calculator",
      "keep track of my habits",
      "add edit delete",
      "a page about volcanoes",
      "an app to track demographic data",
    ]) {
      expect(requiresDatabase(prompt)).toBe(analyzePrompt(prompt).requiresDatabase);
    }
  });

  test("matched lists never contain duplicates", () => {
    const result = analyzePrompt("track and track and track my data records");
    expect(new Set(result.matchedIndicators).size).toBe(result.matchedIndicators.length);
  });
});

describe("getDetailedAnalysis", () => {
  test("names the matching phrase when one drove the decision", () => {
    const result = getDetailedAnalysis("I want to keep track of my running");
    expect(result.summary).toBe('Database required (phrase match: "keep track of")');
  });

  test("counts keywords when no phrase matched", () => {
    const result = getDetailedAnalysis("create, edit and delete my records");
    expect(result.summary).toBe(
      `Database required (${result.matchedIndicators.length} keyword matches)`,
    );
  });

  test("says so plainly when no database is needed", () => {
    expect(getDetailedAnalysis("a calculator").summary).toBe("No database required");
  });

  test("carries the full analyzePrompt result through", () => {
    const prompt = "create, edit and delete my records";
    const { summary, ...rest } = getDetailedAnalysis(prompt);
    expect(typeof summary).toBe("string");
    expect(rest).toEqual(analyzePrompt(prompt));
  });
});
