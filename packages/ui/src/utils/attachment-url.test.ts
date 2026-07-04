/**
 * Unit coverage for attachment-URL safety checks (allowed schemes, SSRF-adjacent
 * rejects). Pure functions, no harness.
 */
import { describe, expect, it } from "vitest";
import { isSafeAttachmentUrl, safeAttachmentUrl } from "./attachment-url";

describe("isSafeAttachmentUrl", () => {
  describe("accepts safe URLs", () => {
    it("accepts https URLs", () => {
      expect(isSafeAttachmentUrl("https://example.com/cat.png")).toBe(true);
      expect(isSafeAttachmentUrl("https://x/y/z?a=1#frag")).toBe(true);
    });

    it("accepts http URLs", () => {
      expect(isSafeAttachmentUrl("http://example.com/clip.mp3")).toBe(true);
    });

    it("accepts root-relative / app URLs", () => {
      expect(isSafeAttachmentUrl("/api/media/abc123")).toBe(true);
      expect(isSafeAttachmentUrl("/foo/bar.png")).toBe(true);
      expect(isSafeAttachmentUrl("/")).toBe(true);
    });

    it("accepts blob URLs", () => {
      expect(isSafeAttachmentUrl("blob:https://x/uuid-1234")).toBe(true);
      expect(isSafeAttachmentUrl("blob:abc")).toBe(true);
    });

    it("accepts allowlisted data: media types", () => {
      expect(isSafeAttachmentUrl("data:image/png;base64,AAAA")).toBe(true);
      expect(isSafeAttachmentUrl("data:image/jpeg;base64,AAAA")).toBe(true);
      expect(isSafeAttachmentUrl("data:audio/mpeg;base64,AAAA")).toBe(true);
      expect(isSafeAttachmentUrl("data:video/mp4;base64,AAAA")).toBe(true);
      expect(isSafeAttachmentUrl("data:application/pdf;base64,AAAA")).toBe(
        true,
      );
      expect(isSafeAttachmentUrl("data:text/plain,hello")).toBe(true);
      // empty media type defaults to text/plain per the data: URL spec
      expect(isSafeAttachmentUrl("data:,hello")).toBe(true);
    });

    it("tolerates surrounding whitespace on safe URLs", () => {
      expect(isSafeAttachmentUrl("  https://example.com/a.png  ")).toBe(true);
      expect(isSafeAttachmentUrl("\thttps://example.com/a.png\n")).toBe(true);
    });

    it("is case-insensitive on the scheme", () => {
      expect(isSafeAttachmentUrl("HTTPS://example.com/a.png")).toBe(true);
      expect(isSafeAttachmentUrl("HtTp://example.com/a.png")).toBe(true);
      expect(isSafeAttachmentUrl("DATA:image/png;base64,AAAA")).toBe(true);
    });
  });

  describe("rejects dangerous schemes", () => {
    it("rejects javascript:", () => {
      expect(isSafeAttachmentUrl("javascript:alert(1)")).toBe(false);
    });

    it("rejects javascript: with a leading space", () => {
      expect(isSafeAttachmentUrl(" javascript:alert(1)")).toBe(false);
    });

    it("rejects mixed-case JaVaScRiPt:", () => {
      expect(isSafeAttachmentUrl("JaVaScRiPt:alert(1)")).toBe(false);
    });

    it("rejects javascript: obfuscated with control characters", () => {
      expect(isSafeAttachmentUrl("java\tscript:alert(1)")).toBe(false);
      expect(isSafeAttachmentUrl("java\nscript:alert(1)")).toBe(false);
      expect(isSafeAttachmentUrl("ja\x00vascript:alert(1)")).toBe(false);
    });

    it("rejects vbscript:", () => {
      expect(isSafeAttachmentUrl("vbscript:msgbox(1)")).toBe(false);
    });

    it("rejects file:", () => {
      expect(isSafeAttachmentUrl("file:///etc/passwd")).toBe(false);
    });

    it("rejects data:text/html", () => {
      expect(
        isSafeAttachmentUrl("data:text/html,<script>alert(1)</script>"),
      ).toBe(false);
      expect(isSafeAttachmentUrl("data:text/html;base64,PHNjcmlwdD4=")).toBe(
        false,
      );
    });

    it("rejects data:image/svg+xml (script-capable)", () => {
      expect(
        isSafeAttachmentUrl("data:image/svg+xml,<svg onload=alert(1)>"),
      ).toBe(false);
      expect(isSafeAttachmentUrl("data:image/svg+xml;base64,PHN2Zz4=")).toBe(
        false,
      );
    });

    it("rejects other / unknown schemes", () => {
      expect(isSafeAttachmentUrl("mailto:a@b.com")).toBe(false);
      expect(isSafeAttachmentUrl("tel:+15555555555")).toBe(false);
      expect(isSafeAttachmentUrl("ftp://host/file")).toBe(false);
      expect(isSafeAttachmentUrl("custom://whatever")).toBe(false);
      expect(isSafeAttachmentUrl("about:blank")).toBe(false);
    });

    it("rejects scheme-relative (//host) URLs", () => {
      expect(isSafeAttachmentUrl("//evil.com/x.png")).toBe(false);
    });
  });

  describe("rejects empty / malformed input", () => {
    it("rejects empty string", () => {
      expect(isSafeAttachmentUrl("")).toBe(false);
    });

    it("rejects whitespace-only input", () => {
      expect(isSafeAttachmentUrl("   ")).toBe(false);
      expect(isSafeAttachmentUrl("\t\n ")).toBe(false);
    });

    it("rejects relative paths without a scheme or leading slash", () => {
      expect(isSafeAttachmentUrl("foo/bar.png")).toBe(false);
      expect(isSafeAttachmentUrl("./local.png")).toBe(false);
      expect(isSafeAttachmentUrl("../up.png")).toBe(false);
    });

    it("rejects malformed inputs", () => {
      expect(isSafeAttachmentUrl(":nonsense")).toBe(false);
      expect(isSafeAttachmentUrl("http")).toBe(false);
      expect(isSafeAttachmentUrl("123:abc")).toBe(false);
      expect(isSafeAttachmentUrl("data:")).toBe(false);
      expect(isSafeAttachmentUrl("data:image/png")).toBe(false);
    });

    it("rejects non-string input defensively", () => {
      // @ts-expect-error - exercising the runtime guard
      expect(isSafeAttachmentUrl(undefined)).toBe(false);
      // @ts-expect-error - exercising the runtime guard
      expect(isSafeAttachmentUrl(null)).toBe(false);
      // @ts-expect-error - exercising the runtime guard
      expect(isSafeAttachmentUrl(123)).toBe(false);
    });
  });
});

describe("safeAttachmentUrl", () => {
  it("returns the URL when it is safe", () => {
    expect(safeAttachmentUrl("https://example.com/a.png")).toBe(
      "https://example.com/a.png",
    );
    expect(safeAttachmentUrl("/api/media/abc")).toBe("/api/media/abc");
  });

  it("returns the default empty fallback when unsafe", () => {
    expect(safeAttachmentUrl("javascript:alert(1)")).toBe("");
    expect(safeAttachmentUrl("file:///etc/passwd")).toBe("");
    expect(safeAttachmentUrl("")).toBe("");
  });

  it("returns a custom fallback when unsafe", () => {
    expect(safeAttachmentUrl("javascript:alert(1)", "/placeholder.png")).toBe(
      "/placeholder.png",
    );
    expect(safeAttachmentUrl("data:text/html,x", "about:blank")).toBe(
      "about:blank",
    );
  });
});
