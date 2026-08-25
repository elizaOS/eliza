/**
 * Unit coverage for the model-hub display helpers (pure functions, no DOM).
 */

import { describe, expect, it } from "vitest";
import { displayModelName } from "./hub-utils";

describe("displayModelName", () => {
  it("uses active Eliza-1 size ids as display names", () => {
    expect(displayModelName({ id: "eliza-1-2b" })).toBe("eliza-1-2b");
    expect(displayModelName({ id: "eliza-1-27b" })).toBe("eliza-1-27b");
    expect(displayModelName({ id: "eliza-1-27b-drafter" })).toBe(
      "eliza-1-27b drafter",
    );
  });
});
