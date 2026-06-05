import { describe, expect, it } from "vitest";
import { parseComposerDirectives } from "./composer-directives";

describe("parseComposerDirectives", () => {
  it("returns plain text unchanged with no profile", () => {
    expect(parseComposerDirectives("build a trivia app")).toEqual({
      goal: "build a trivia app",
    });
  });

  it("strips the /economics directive and sets the economics profile", () => {
    expect(
      parseComposerDirectives("/economics build a monetized trivia app"),
    ).toEqual({
      goal: "build a monetized trivia app",
      capabilityProfile: "economics",
    });
  });

  it("is case-insensitive and trims surrounding whitespace", () => {
    expect(parseComposerDirectives("  /Economics   ship it  ")).toEqual({
      goal: "ship it",
      capabilityProfile: "economics",
    });
  });

  it("accepts the /monetize alias", () => {
    expect(parseComposerDirectives("/monetize a notes app")).toEqual({
      goal: "a notes app",
      capabilityProfile: "economics",
    });
  });

  it("does not treat a non-directive slash word as economics", () => {
    expect(parseComposerDirectives("/economical budget app")).toEqual({
      goal: "/economical budget app",
    });
  });

  it("handles a bare directive with an empty goal", () => {
    expect(parseComposerDirectives("/economics")).toEqual({
      goal: "",
      capabilityProfile: "economics",
    });
  });
});
