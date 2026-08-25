import { describe, expect, it } from "vitest";
import { assertValidWhatsAppMediaLink } from "./media";

describe("assertValidWhatsAppMediaLink", () => {
  it("accepts a well-formed https URL", () => {
    expect(assertValidWhatsAppMediaLink("https://cdn.example.com/a.jpg", "image")).toBe(
      "https://cdn.example.com/a.jpg"
    );
  });

  it("accepts an http URL", () => {
    const out = assertValidWhatsAppMediaLink("http://cdn.example.com/a.jpg", "video");
    expect(out.startsWith("http://cdn.example.com/a.jpg")).toBe(true);
  });

  it("trims surrounding whitespace before validation", () => {
    expect(assertValidWhatsAppMediaLink("  https://cdn.example.com/a.jpg  ", "image")).toBe(
      "https://cdn.example.com/a.jpg"
    );
  });

  it("preserves query strings and paths", () => {
    const out = assertValidWhatsAppMediaLink(
      "https://cdn.example.com/path/x.png?token=abc&expires=1",
      "image"
    );
    expect(out).toBe("https://cdn.example.com/path/x.png?token=abc&expires=1");
  });

  it("rejects non-string inputs", () => {
    expect(() => assertValidWhatsAppMediaLink(42, "image")).toThrow();
    expect(() => assertValidWhatsAppMediaLink(null, "image")).toThrow();
    expect(() => assertValidWhatsAppMediaLink(undefined, "image")).toThrow();
    expect(() => assertValidWhatsAppMediaLink({ url: "https://x" }, "image")).toThrow();
  });

  it("rejects empty and whitespace-only strings", () => {
    expect(() => assertValidWhatsAppMediaLink("", "image")).toThrow();
    expect(() => assertValidWhatsAppMediaLink("   ", "image")).toThrow();
  });

  it("rejects non-http(s) protocols (SSRF guard)", () => {
    expect(() => assertValidWhatsAppMediaLink("file:///etc/passwd", "image")).toThrow();
    expect(() =>
      assertValidWhatsAppMediaLink("data:text/plain;base64,SGVsbG8=", "image")
    ).toThrow();
    expect(() => assertValidWhatsAppMediaLink("javascript:alert(1)", "image")).toThrow();
    expect(() => assertValidWhatsAppMediaLink("ftp://cdn.example.com/a.jpg", "image")).toThrow();
  });

  it("rejects URLs embedding credentials", () => {
    expect(() =>
      assertValidWhatsAppMediaLink("https://user:pass@cdn.example.com/a.jpg", "image")
    ).toThrow();
    expect(() =>
      assertValidWhatsAppMediaLink("https://user@cdn.example.com/a.jpg", "image")
    ).toThrow();
  });

  it("normalizes scheme-only URLs to a hostname (WHATWG URL parsing)", () => {
    // "https:///a.jpg" is parsed by WHATWG URL as host "a.jpg" (empty
    // authority + path), so the guard accepts it — pinned as current behavior.
    expect(() => assertValidWhatsAppMediaLink("https:///a.jpg", "image")).not.toThrow();
  });

  it("rejects malformed URL strings", () => {
    expect(() => assertValidWhatsAppMediaLink("not a url", "image")).toThrow();
    expect(() => assertValidWhatsAppMediaLink("https://", "image")).toThrow();
  });

  it("accepts localhost hosts (explicit current behavior)", () => {
    expect(() =>
      assertValidWhatsAppMediaLink("http://localhost:3000/a.jpg", "image")
    ).not.toThrow();
    expect(() => assertValidWhatsAppMediaLink("http://127.0.0.1/a.jpg", "image")).not.toThrow();
  });

  it("embeds the media kind in the rejection message", () => {
    expect(() => assertValidWhatsAppMediaLink("file:///x", "sticker")).toThrow(
      "sticker message requires a valid http(s) media link"
    );
  });
});
