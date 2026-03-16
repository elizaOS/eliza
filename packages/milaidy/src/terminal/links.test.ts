import { describe, expect, it } from "vitest";
import { formatTerminalLink, formatDocsLink } from "./links.js";

describe("formatTerminalLink", () => {
  describe("when force is false", () => {
    it("returns label (url) format", () => {
      const result = formatTerminalLink("Click here", "https://example.com", { force: false });
      expect(result).toBe("Click here (https://example.com)");
    });

    it("uses custom fallback when provided", () => {
      const result = formatTerminalLink("Click", "https://example.com", {
        force: false,
        fallback: "see https://example.com",
      });
      expect(result).toBe("see https://example.com");
    });
  });

  describe("when force is true", () => {
    it("returns OSC 8 escape sequence", () => {
      const result = formatTerminalLink("Click", "https://example.com", { force: true });
      expect(result).toBe("\u001b]8;;https://example.com\u0007Click\u001b]8;;\u0007");
    });
  });

  describe("escape character safety", () => {
    it("strips ESC from label", () => {
      const result = formatTerminalLink("\u001b[31mRed\u001b[0m", "https://a.com", {
        force: false,
      });
      expect(result).not.toContain("\u001b");
      expect(result).toContain("[31mRed[0m");
    });

    it("strips ESC from url", () => {
      const result = formatTerminalLink("Link", "https://a.com/\u001bpath", { force: false });
      expect(result).not.toContain("\u001b");
      expect(result).toContain("https://a.com/path");
    });

    it("strips ESC in forced mode too", () => {
      const result = formatTerminalLink("\u001bBad", "https://\u001bx.com", { force: true });
      expect(result).toBe("\u001b]8;;https://x.com\u0007Bad\u001b]8;;\u0007");
    });
  });

  it("handles empty label and url", () => {
    const result = formatTerminalLink("", "", { force: false });
    expect(result).toBe(" ()");
  });
});

describe("formatDocsLink", () => {
  it("prepends docs root for relative paths", () => {
    const result = formatDocsLink("/getting-started", undefined, { force: false });
    expect(result).toBe("https://docs.milaidy.ai/getting-started");
  });

  it("prepends / when path does not start with /", () => {
    const result = formatDocsLink("guide/setup", undefined, { force: false });
    expect(result).toBe("https://docs.milaidy.ai/guide/setup");
  });

  it("passes through absolute URLs unchanged", () => {
    const result = formatDocsLink("https://custom.dev/page", undefined, { force: false });
    expect(result).toBe("https://custom.dev/page");
  });

  it("uses provided label in link text when forced", () => {
    const result = formatDocsLink("/api", "API Docs", { force: true });
    expect(result).toBe("\u001b]8;;https://docs.milaidy.ai/api\u0007API Docs\u001b]8;;\u0007");
  });

  it("uses url as fallback when force is false", () => {
    const result = formatDocsLink("/api", "API Docs", { force: false });
    expect(result).toBe("https://docs.milaidy.ai/api");
  });

  it("uses custom fallback", () => {
    const result = formatDocsLink("/api", "API", { force: false, fallback: "docs: /api" });
    expect(result).toBe("docs: /api");
  });

  it("trims path whitespace", () => {
    const result = formatDocsLink("  /trimmed  ", undefined, { force: false });
    expect(result).toBe("https://docs.milaidy.ai/trimmed");
  });
});
