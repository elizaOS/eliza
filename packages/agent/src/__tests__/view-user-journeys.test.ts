/**
 * Validates the view-journey catalog as deterministic test and exploratory
 * input. Runtime behavior is exercised by the app-control and scenario suites;
 * this file only enforces the catalog's structural invariants.
 */

import { describe, expect, it } from "vitest";
import {
  countViewJourneyScenarios,
  getScenarioById,
  getScenariosByTag,
  VIEW_USER_JOURNEYS,
} from "./view-user-journeys.js";

describe("view-user-journeys scenario library", () => {
  it("contains at least 20 scenarios", () => {
    expect(VIEW_USER_JOURNEYS.length).toBeGreaterThanOrEqual(20);
  });

  it("expands the curated base set by exactly 10x", () => {
    expect(countViewJourneyScenarios()).toEqual({
      existing: 34,
      added: 340,
      total: 374,
      multiplierAdded: 10,
    });
  });

  it("all scenario ids are unique", () => {
    const ids = VIEW_USER_JOURNEYS.map((scenario) => scenario.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all scenarios have required fields", () => {
    for (const scenario of VIEW_USER_JOURNEYS) {
      expect(scenario.id, "scenario missing id").toBeTruthy();
      expect(
        scenario.description,
        `scenario ${scenario.id} missing description`,
      ).toBeTruthy();
      expect(
        scenario.userMessage,
        `scenario ${scenario.id} missing userMessage`,
      ).toBeTruthy();
      expect(
        scenario.expectedBehavior,
        `scenario ${scenario.id} missing expectedBehavior`,
      ).toBeTruthy();
      expect(
        scenario.verificationCriteria.length,
        `scenario ${scenario.id} has no verification criteria`,
      ).toBeGreaterThan(0);
      expect(
        scenario.tags.length,
        `scenario ${scenario.id} has no tags`,
      ).toBeGreaterThan(0);
    }
  });

  it("gets a scenario by id", () => {
    const scenario = getScenarioById("show-all-views");
    expect(scenario).toMatchObject({
      id: "show-all-views",
      userMessage: "show me all views",
    });
  });

  it("rejects an unknown scenario id", () => {
    expect(() => getScenarioById("nonexistent-id")).toThrow();
  });

  it("returns only scenarios matching a requested tag", () => {
    const scenarios = getScenariosByTag("navigation");
    expect(scenarios.length).toBeGreaterThan(0);
    for (const scenario of scenarios) {
      expect(scenario.tags).toContain("navigation");
    }
  });

  it("returns the union for multiple requested tags", () => {
    const tags = ["discovery", "error-handling"];
    for (const scenario of getScenariosByTag(...tags)) {
      expect(scenario.tags.some((tag) => tags.includes(tag))).toBe(true);
    }
  });

  it("uses only the documented tag vocabulary", () => {
    const knownTags = new Set([
      "discovery",
      "navigation",
      "view-manager",
      "search",
      "error-handling",
      "permissions",
      "capabilities",
      "plugin-install",
      "desktop",
      "voice",
      "interaction",
      "multi-turn",
      "e2e",
    ]);
    for (const scenario of VIEW_USER_JOURNEYS) {
      for (const tag of scenario.tags) {
        expect(
          knownTags.has(tag),
          `Unknown tag "${tag}" in scenario "${scenario.id}"`,
        ).toBe(true);
      }
    }
  });
});
