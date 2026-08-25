/**
 * Coverage for AI pricing fetch helpers.
 */
import { describe, expect, it } from "vitest";

import { stripHtml } from "./fetch.js";

describe("stripHtml", () => {
  it("removes tags", () => {
    expect(stripHtml("<p>hello <b>world</b></p>")).toBe("hello world");
  });

  it("handles empty and plain", () => {
    expect(stripHtml("")).toBe("");
    expect(stripHtml("plain")).toBe("plain");
  });

  it("collapses whitespace", () => {
    expect(stripHtml("<div> a   b </div>")).toBe("a b");
  });

  it("handles entities", () => {
    expect(stripHtml("a&nbsp;b")).toBe("a b");
  });

  it("trims", () => {
    expect(stripHtml("  <p> hi </p>  ")).toBe("hi");
  });
});
