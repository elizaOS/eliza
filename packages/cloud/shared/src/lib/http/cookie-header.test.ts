import { describe, expect, it } from "vitest";
import { getCookieValueFromHeader } from "./cookie-header";

describe("getCookieValueFromHeader", () => {
  it("reads a single cookie and decodes it", () => {
    expect(getCookieValueFromHeader("a=1; eliza_session=abc%3D; b=2", "eliza_session")).toBe(
      "abc=",
    );
  });

  it("accepts identical host-only and domain copies", () => {
    expect(
      getCookieValueFromHeader("eliza_session=same; eliza_session=same", "eliza_session"),
    ).toBe("same");
  });

  it("rejects duplicated cookies with differing values instead of picking one", () => {
    expect(
      getCookieValueFromHeader(
        "eliza_session=first; other=x; eliza_session=second",
        "eliza_session",
      ),
    ).toBeUndefined();
    expect(getCookieValueFromHeader("other=x", "eliza_session")).toBeUndefined();
    expect(
      getCookieValueFromHeader("eliza_session=first; other=x; eliza_session=second", "other"),
    ).toBe("x");
  });

  it("treats malformed, empty, and absent cookies as absent", () => {
    expect(getCookieValueFromHeader("eliza_session=%E0%A4%A", "eliza_session")).toBeUndefined();
    expect(
      getCookieValueFromHeader("eliza_session=valid; eliza_session=%E0%A4%A", "eliza_session"),
    ).toBeUndefined();
    expect(getCookieValueFromHeader("eliza_session=", "eliza_session")).toBeUndefined();
    expect(
      getCookieValueFromHeader("eliza_session=; eliza_session=x", "eliza_session"),
    ).toBeUndefined();
    expect(getCookieValueFromHeader(null, "eliza_session")).toBeUndefined();
  });

  it("keeps the zero value as a present value", () => {
    expect(getCookieValueFromHeader("eliza_session=0", "eliza_session")).toBe("0");
  });
});
