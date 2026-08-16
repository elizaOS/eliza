/**
 * Unit-tests the cross-request duplicate-spawn guard's pure pieces: the goal
 * similarity metric on the live observed duplicate pair, threshold behavior on
 * unrelated goals, and the explicit force-phrase escape. Pure functions, no
 * runtime.
 */
import { describe, expect, test } from "vitest";
import { DUPLICATE_SPAWN_FORCE_RE, goalSimilarity } from "./tasks.js";

describe("goalSimilarity", () => {
  test("live duplicate pair scores above the guard threshold", () => {
    const existing =
      "Build a single-page personal website for nubs — a guy who collects mechanical keyboards. dark theme, clean, a lil personality";
    const duplicate =
      "Nubs mechanical keyboard site Build a single-page personal website for nubs who collects mechanical keyboards";
    expect(goalSimilarity(duplicate, existing)).toBeGreaterThanOrEqual(0.6);
  });

  test("unrelated goals stay below threshold", () => {
    expect(
      goalSimilarity(
        "fix the failing unit tests in the billing package",
        "Build a single-page personal website for nubs mechanical keyboards",
      ),
    ).toBeLessThan(0.6);
  });

  test("empty text never matches", () => {
    expect(goalSimilarity("", "anything at all here")).toBe(0);
  });
});

describe("DUPLICATE_SPAWN_FORCE_RE", () => {
  test("explicit repeat phrasing escapes the guard", () => {
    for (const text of [
      "run it again",
      "build another one",
      "start a fresh task",
      "retry the build",
      "redo it from scratch",
    ]) {
      expect(DUPLICATE_SPAWN_FORCE_RE.test(text)).toBe(true);
    }
  });

  test("status-shaped asks do not escape", () => {
    for (const text of [
      "so is my site done?? where can i see it",
      "whats the status of the build",
      "did it finish",
    ]) {
      expect(DUPLICATE_SPAWN_FORCE_RE.test(text)).toBe(false);
    }
  });
});
