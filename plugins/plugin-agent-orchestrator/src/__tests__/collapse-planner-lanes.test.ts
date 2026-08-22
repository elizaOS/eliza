import { describe, expect, it } from "vitest";
import { collapsePlannerLanes } from "../actions/tasks.js";

const PHASES = [
  "Build Tetris game logic and UI",
  "Implement levels and scoring",
  "Create local storage leaderboard",
  "Finalize styling and responsive layout",
];

describe("collapsePlannerLanes", () => {
  it("folds a phased single page build into one lane led by the whole task", () => {
    const lanes = collapsePlannerLanes(
      "build me a lil tetris page with levels and a leaderboard",
      PHASES,
      "Build a Tetris game page with levels and a leaderboard.",
    );
    expect(lanes).toHaveLength(1);
    expect(lanes[0].startsWith("Build a Tetris game page")).toBe(true);
    expect(lanes[0]).toContain("Implement levels and scoring");
  });

  it("folds a phased script ask into one lane", () => {
    expect(
      collapsePlannerLanes(
        "write me a python script that picks a random card and prints it",
        ["define the deck", "pick and print a card"],
        undefined,
      ),
    ).toHaveLength(1);
  });

  it("keeps lanes for a plural ask and for unrelated targets", () => {
    expect(
      collapsePlannerLanes(
        "build me three pages: a todo list, a timer, and a notes page",
        ["todo list page", "timer page", "notes page"],
        undefined,
      ),
    ).toHaveLength(3);
    expect(
      collapsePlannerLanes(
        "refactor the auth module and update the docs",
        ["refactor auth", "update docs"],
        undefined,
      ),
    ).toHaveLength(2);
  });

  it("still folds app edits and single-repo PR asks", () => {
    expect(
      collapsePlannerLanes(
        "make the unit converter page dark mode",
        ["add theme toggle", "dark palette", "persist choice"],
        undefined,
      ),
    ).toHaveLength(1);
    expect(
      collapsePlannerLanes(
        "add CONTRIBUTING.md to my repo and open a PR",
        ["write CONTRIBUTING.md", "open the PR"],
        undefined,
      ),
    ).toHaveLength(1);
  });
});
