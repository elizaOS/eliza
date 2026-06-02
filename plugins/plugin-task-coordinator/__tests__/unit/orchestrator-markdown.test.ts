import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  MarkdownText,
  sanitizeMarkdownUrl,
} from "../../src/orchestrator-markdown";

describe("orchestrator markdown", () => {
  it("allows only safe markdown link and image protocols", () => {
    expect(sanitizeMarkdownUrl("https://example.com", "link")).toBe(
      "https://example.com",
    );
    expect(sanitizeMarkdownUrl("mailto:ops@example.com", "link")).toBe(
      "mailto:ops@example.com",
    );
    expect(sanitizeMarkdownUrl("/relative/path", "link")).toBe(
      "/relative/path",
    );
    expect(sanitizeMarkdownUrl("javascript:alert(1)", "link")).toBeNull();
    expect(sanitizeMarkdownUrl("data:text/html,<svg>", "image")).toBeNull();
    expect(sanitizeMarkdownUrl("file:///etc/passwd", "image")).toBeNull();
  });

  it("renders unsafe link and image urls without href or src attributes", () => {
    const html = renderToStaticMarkup(
      createElement(MarkdownText, {
        text:
          "[safe](https://example.com) [bad](javascript:alert(1)) " +
          "![pixel](data:image/png;base64,aaa)",
      }),
    );

    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:image");
    expect(html).toContain("bad");
    expect(html).toContain("pixel");
  });
});
