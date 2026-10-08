/** A site path must not become part of the domain used for the lookup. */
import { describe, expect, it } from "vitest";
import { normalizeDomain } from "./screen-time.ts";

describe("normalizeDomain", () => {
  it("drops a path from a bare host the same way a URL does", () => {
    expect(normalizeDomain("nytimes.com/section")).toBe("nytimes.com");
    expect(normalizeDomain("https://nytimes.com/section")).toBe("nytimes.com");
  });

  it("keeps a bare host and rejects an empty URL", () => {
    expect(normalizeDomain("nytimes.com")).toBe("nytimes.com");
    expect(normalizeDomain("https://")).toBe("");
  });

  it("does not invent a host from a path or a non-http scheme", () => {
    expect(normalizeDomain("/section")).toBe("");
    expect(normalizeDomain("ftp://nytimes.com/x")).toBe("");
  });
});
