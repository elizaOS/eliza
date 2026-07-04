/**
 * Sub-agent naming guarantees an operator can tell workers apart: an explicit
 * label is always kept, and an auto-assigned name never collides with a live
 * sibling or with the parent agent. These invariants hold for every RNG
 * outcome, so iterating many times can't flake.
 */

import { describe, expect, it } from "vitest";
import {
  assignAgentName,
  pickSubAgentName,
} from "../../src/services/agent-name-assignment.js";

const RUNS = 100;

describe("pickSubAgentName", () => {
  it("returns a non-empty name", () => {
    expect(pickSubAgentName().length).toBeGreaterThan(0);
  });

  it("never returns an excluded name (case-insensitive)", () => {
    const excluded = ["reimu", "SAKUYA"];
    for (let i = 0; i < RUNS; i++) {
      const name = pickSubAgentName(["Reimu", "Sakuya"]).toLowerCase();
      expect(excluded).not.toContain(name);
    }
  });
});

describe("assignAgentName", () => {
  it("keeps an explicit label verbatim (trimmed) over the pool", () => {
    expect(
      assignAgentName({ explicitLabel: "  Atlas  ", activeNames: [] }),
    ).toBe("Atlas");
  });

  it("falls back to the pool when the explicit label is blank", () => {
    const name = assignAgentName({ explicitLabel: "   ", activeNames: [] });
    expect(name.length).toBeGreaterThan(0);
  });

  it("never reuses a live sibling's name or the parent agent's name", () => {
    const activeNames = ["Marisa", "Youmu"];
    const mainAgentName = "Reimu";
    for (let i = 0; i < RUNS; i++) {
      const name = assignAgentName({ activeNames, mainAgentName });
      expect(activeNames.map((n) => n.toLowerCase())).not.toContain(
        name.toLowerCase(),
      );
      expect(name.toLowerCase()).not.toBe(mainAgentName.toLowerCase());
    }
  });
});
