/**
 * Regression: numeric HTML entities in Gmail HTML bodies must decode through
 * the WHATWG windows-1252 table for the C1 range (&#128;-&#159;), matching
 * decodeBasicHtmlEntities in plugin-assistant. Raw String.fromCodePoint made
 * them invisible C1 control characters in the plain text the agent reads, and
 * decoded the unassigned slots instead of leaving them as written.
 */
import { describe, expect, test } from "bun:test";
import { normalizeManagedGmailBodyText } from "./gmail";

describe("normalizeManagedGmailBodyText C1 numeric entities", () => {
  test("maps assigned C1 references through windows-1252", () => {
    expect(normalizeManagedGmailBodyText("<p>A&#128;B</p>")).toBe("A\u20acB");
    expect(normalizeManagedGmailBodyText("<p>A&#130;B</p>")).toBe("A\u201aB");
    expect(normalizeManagedGmailBodyText("<p>A&#150;B</p>")).toBe("A\u2013B");
    expect(normalizeManagedGmailBodyText("<p>A&#159;B</p>")).toBe("A\u0178B");
    expect(normalizeManagedGmailBodyText("<p>A&#x80;B</p>")).toBe("A\u20acB");
  });

  test("leaves unassigned C1 slots as written", () => {
    expect(normalizeManagedGmailBodyText("<p>A&#129;B</p>")).toBe("A&#129;B");
    expect(normalizeManagedGmailBodyText("<p>A&#141;B</p>")).toBe("A&#141;B");
    expect(normalizeManagedGmailBodyText("<p>A&#157;B</p>")).toBe("A&#157;B");
  });

  test("keeps non-C1 decoding unchanged", () => {
    expect(normalizeManagedGmailBodyText("<p>A&#0;B</p>")).toBe("A&#0;B");
    expect(normalizeManagedGmailBodyText("<p>A&#8211;B</p>")).toBe("A\u2013B");
    expect(normalizeManagedGmailBodyText("<p>A&#8217;B</p>")).toBe("A\u2019B");
    expect(normalizeManagedGmailBodyText("<p>A&amp;B</p>")).toBe("A&B");
  });

  test("does not render a bullet for tags that merely start with li", () => {
    // Only the li tag is a list item; link and custom elements stay plain.
    expect(
      normalizeManagedGmailBodyText(
        '<html><head><link rel="stylesheet" href="https://x.example/a.css"></head><body><p>Hello world</p></body></html>',
      ),
    ).toBe("Hello world");
    expect(normalizeManagedGmailBodyText("<li-custom>Widget</li-custom>")).toBe("Widget");
    expect(normalizeManagedGmailBodyText("<ul><li>First</li><li>Second</li></ul>")).toBe(
      "- First\n- Second",
    );
  });
});
