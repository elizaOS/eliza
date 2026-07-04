// Exercises training core utilities used by trajectory and LifeOps datasets.
import { describe, expect, it } from "vitest";
import { escapeHtml, escapeScriptJson } from "./html-escape";

/**
 * Tests for the HTML/JSON escapers (#8801 / #9943). These are XSS boundaries:
 * escapeHtml entity-encodes user text rendered into markup, and escapeScriptJson
 * escapes `<` so embedded JSON can't break out of an inline <script>. Both were
 * untested; a regression here is a cross-site-scripting hole.
 */
describe("escapeHtml", () => {
  it("escapes the four HTML-significant characters", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    expect(escapeHtml('a & "b"')).toBe("a &amp; &quot;b&quot;");
  });

  it("escapes & first so an existing entity double-encodes (no under-escaping)", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("escapes a full tag with attributes", () => {
    expect(escapeHtml('<a href="x">')).toBe("&lt;a href=&quot;x&quot;&gt;");
  });
});

describe("escapeScriptJson", () => {
  it("serializes a value to JSON", () => {
    expect(escapeScriptJson({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("escapes < as \\u003c to prevent a </script> breakout", () => {
    expect(escapeScriptJson("</script>")).toBe('"\\u003c/script>"');
    expect(escapeScriptJson({ html: "<b>" })).toBe('{"html":"\\u003cb>"}');
  });

  it("leaves no raw < that could open or close a tag", () => {
    const out = escapeScriptJson({ payload: "<svg onload=alert(1)>" });
    expect(out).not.toContain("<");
  });
});
