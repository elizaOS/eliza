import { describe, expect, it } from "vitest";
import { escapeLikePattern } from "./like-pattern.js";

describe("escapeLikePattern", () => {
  it("escapes percent and underscore and backslash", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  it("returns empty for empty", () => {
    expect(escapeLikePattern("")).toBe("");
  });

  it("leaves normal text unchanged", () => {
    expect(escapeLikePattern("hello world")).toBe("hello world");
  });

  it("handles multiple specials", () => {
    expect(escapeLikePattern("%%__\\\\")).toBe("\\%\\%\\_\\_\\\\\\\\");
  });
});
