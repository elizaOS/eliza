import { describe, expect, it } from "vitest";
import { escapeHtml, serializeInlineScriptValue } from "./html.js";

describe("html utils", () => {
  it("escapes html entities", () => {
    expect(escapeHtml('<a href="x">&\'')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#039;");
    expect(escapeHtml("hello")).toBe("hello");
  });

  it("serializes inline script value escaping", () => {
    const s = serializeInlineScriptValue({ x: "</script>" });
    expect(s).not.toContain("</script>");
    expect(s).toContain("\\u003c");
  });

  it("throws on non-serializable", () => {
    expect(() => serializeInlineScriptValue(undefined as unknown as string)).toThrow(TypeError);
  });

  it("escapes ampersand and unicode line separators", () => {
    const s = serializeInlineScriptValue("a & b \u2028 c");
    expect(s).toContain("\\u0026");
    expect(s).toContain("\\u2028");
  });
});
