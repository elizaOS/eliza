import { sanitizeLinkHref } from "@elizaos/app-core/config";
import { describe, expect, it } from "vitest";

describe("sanitizeLinkHref", () => {
  it("blocks executable protocols", () => {
    expect(sanitizeLinkHref("javascript:alert(1)")).toBe("#");
    expect(sanitizeLinkHref(" data:text/html,<svg/onload=alert(1)>")).toBe("#");
    expect(sanitizeLinkHref("VBSCRIPT:msgbox(1)")).toBe("#");
  });

  it("blocks file: protocol (desktop filesystem exposure)", () => {
    expect(sanitizeLinkHref("file:///etc/passwd")).toBe("#");
    expect(sanitizeLinkHref("FILE:///C:/Windows/System32")).toBe("#");
  });

  it("blocks control-character obfuscation bypasses", () => {
    expect(sanitizeLinkHref("java\nscript:alert(1)")).toBe("#");
    expect(sanitizeLinkHref("java\tscript:alert(1)")).toBe("#");
    expect(sanitizeLinkHref("java\rscript:alert(1)")).toBe("#");
    expect(sanitizeLinkHref("dat\na:text/html,x")).toBe("#");
  });

  it("preserves safe links", () => {
    expect(sanitizeLinkHref("https://example.com")).toBe("https://example.com");
    expect(sanitizeLinkHref("mailto:test@example.com")).toBe(
      "mailto:test@example.com",
    );
    expect(sanitizeLinkHref("/settings")).toBe("/settings");
    expect(sanitizeLinkHref("#section")).toBe("#section");
    expect(sanitizeLinkHref("./relative")).toBe("./relative");
    expect(sanitizeLinkHref("../parent")).toBe("../parent");
    expect(sanitizeLinkHref("?query=1")).toBe("?query=1");
  });

  it("falls back safely for blank values", () => {
    expect(sanitizeLinkHref("")).toBe("#");
    expect(sanitizeLinkHref(undefined)).toBe("#");
  });
});
