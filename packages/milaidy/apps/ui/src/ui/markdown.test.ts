import { describe, expect, it } from "vitest";

// Dynamic imports to handle missing dompurify in non-browser environments
const hasDocument = typeof document !== "undefined" && typeof document.createElement === "function";

// Skip this entire test module if no DOM is available (module dependencies require browser environment)
if (!hasDocument) {
  describe.skip("toSanitizedMarkdownHtml (requires DOM)", () => {
    it("skipped - no DOM environment", () => {});
  });
} else {
  const { toSanitizedMarkdownHtml } = await import("./markdown.js");

  describe("toSanitizedMarkdownHtml", () => {
    it("renders basic markdown", () => {
      const html = toSanitizedMarkdownHtml("Hello **world**");
      expect(html).toContain("<strong>world</strong>");
    });

    it("strips scripts and unsafe links", () => {
      const html = toSanitizedMarkdownHtml(
        [
          "<script>alert(1)</script>",
          "",
          "[x](javascript:alert(1))",
          "",
          "[ok](https://example.com)",
        ].join("\n"),
      );
      expect(html).not.toContain("<script");
      expect(html).not.toContain("javascript:");
      expect(html).toContain("https://example.com");
    });

    it("renders fenced code blocks", () => {
      const html = toSanitizedMarkdownHtml(["```ts", "console.log(1)", "```"].join("\n"));
      expect(html).toContain("<pre>");
      expect(html).toContain("<code");
      expect(html).toContain("console.log(1)");
    });
  });
}
