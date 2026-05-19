import { describe, expect, it } from "vitest";
import { displayModelName } from "./hub-utils";

describe("displayModelName", () => {
  it("uses active Eliza-1 size ids as display names", () => {
    expect(displayModelName({ id: "eliza-1-0_8b" })).toBe("eliza-1-0_8b");
    expect(displayModelName({ id: "eliza-1-27b" })).toBe("eliza-1-27b");
    expect(displayModelName({ id: "eliza-1-27b-drafter" })).toBe(
      "eliza-1-27b drafter",
    );
  });
});
