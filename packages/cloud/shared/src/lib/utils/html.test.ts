/**
 * Coverage for html utils.
 */
import { describe, expect, it } from "vitest";
import { escapeHtml, serializeInlineScriptValue } from "./html.js";

describe("html", () => {
  it("escapes html", () => {
    expect(escapeHtml("<div>&\"'")).toBe("&lt;div&gt;&amp;&quot;&#039;");
  });
  it("serializes script value", () => {
    expect(serializeInlineScriptValue({ a: 1 })).toContain("a");
  });
  it("escapes script tag", () => {
    expect(serializeInlineScriptValue("</script>")).toContain("\\u003c");
  });
  it("throws on undefined", () => {
    expect(() => serializeInlineScriptValue(undefined)).toThrow();
  });
});
