import { describe, expect, it } from "vitest";
import { getCookieValueFromHeader, getCookieValueFromRequest } from "./cookie-header.js";

describe("cookie-header", () => {
  it("parses single cookie", () => {
    expect(getCookieValueFromHeader("a=1; b=2", "b")).toBe("2");
    expect(getCookieValueFromHeader("token=abc%20def", "token")).toBe("abc def");
  });

  it("returns undefined for missing or null", () => {
    expect(getCookieValueFromHeader(null, "a")).toBeUndefined();
    expect(getCookieValueFromHeader("a=1", "missing")).toBeUndefined();
  });

  it("handles malformed encoding as undefined", () => {
    expect(getCookieValueFromHeader("bad=%ZZ", "bad")).toBeUndefined();
  });

  it("reads from Request", () => {
    const req = new Request("https://example.com", { headers: { cookie: "x=hello" } });
    expect(getCookieValueFromRequest(req, "x")).toBe("hello");
    expect(getCookieValueFromRequest(req, "y")).toBeUndefined();
  });
});
