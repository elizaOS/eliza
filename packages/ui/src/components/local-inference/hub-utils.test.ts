import { describe, expect, it } from "vitest";
import { displayModelName } from "./hub-utils";

describe("displayModelName", () => {
  it("keeps long-context Eliza-1 tiers distinct", () => {
    expect(displayModelName({ id: "eliza-1-27b-256k" })).toBe(
      "eliza-1-27b-256k",
    );
    expect(displayModelName({ id: "eliza-1-27b-256k-drafter" })).toBe(
      "eliza-1-27b-256k drafter",
    );
  });
});
