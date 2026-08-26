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

/**
 * escapeHtml guards Cloud response interpolation (oidc error pages, GitHub
 * return pages) and serializeInlineScriptValue guards JSON values embedded in
 * HTML <script> elements (app frontend hosting window globals). A regression
 * here is an XSS class bug, so these assertions pin exact escaped bytes, the
 * ampersand-first replacement order, and full script-terminator suppression.
 */
describe("escapeHtml edge contract", () => {
  it("escapes each metacharacter to its exact replacement bytes", () => {
    expect(escapeHtml("&")).toBe("&amp;");
    expect(escapeHtml("<")).toBe("&lt;");
    expect(escapeHtml(">")).toBe("&gt;");
    expect(escapeHtml('"')).toBe("&quot;");
    expect(escapeHtml("'")).toBe("&#039;");
  });

  it("replaces ampersands first so introduced entities are never double-escaped", () => {
    // If `<` were replaced before `&`, the produced `&lt;` would itself be
    // rewritten to `&amp;lt;`. Length pinning proves the ordering.
    expect(escapeHtml("<")).toHaveLength(4);
    // Pre-escaped input must survive as text, not be mangled into a new entity.
    expect(escapeHtml("&lt;script&gt;")).toBe("&amp;lt;script&amp;gt;");
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("leaves safe text untouched", () => {
    expect(escapeHtml("")).toBe("");
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
    expect(escapeHtml("café ☕")).toBe("café ☕");
  });

  it("neutralizes markup and attribute-context injection payloads", () => {
    const escaped = escapeHtml('<script>alert("x")</script>');
    expect(escaped).not.toMatch(/[<>"']/);
    expect(escaped).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");

    // Both quote styles must die so the value cannot break out of either a
    // double-quoted or single-quoted HTML attribute.
    const attr = escapeHtml("x' onclick='alert(1)");
    expect(attr).toBe("x&#039; onclick=&#039;alert(1)");
    expect(escapeHtml('"><svg onload=alert(1)>')).toBe("&quot;&gt;&lt;svg onload=alert(1)&gt;");
  });
});

describe("serializeInlineScriptValue edge contract", () => {
  it("escapes every angle bracket so no script terminator can survive", () => {
    const serialized = serializeInlineScriptValue({
      redirect: "</script><script>alert(1)</script>",
      upper: "</SCRIPT>",
      spaced: "</script >",
      commentClose: "-->",
    });
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain("</");
    expect(serialized).not.toContain(">");
    expect(serialized).toContain("--\\u003e");
    expect(serialized).toContain("\\u003c/script\\u003e");
    // Nested values get the escapes too: the transform runs on the whole
    // serialized document, not only top-level strings.
    expect(serialized).toContain("\\u003c/SCRIPT\\u003e");
  });

  it("escapes ampersands so entities cannot re-form during HTML re-parsing", () => {
    expect(serializeInlineScriptValue("fish & chips")).toBe('"fish \\u0026 chips"');
    expect(serializeInlineScriptValue({ query: "?a=1&b=2" })).toContain("?a=1\\u0026b=2");
  });

  it("escapes U+2028/U+2029 line separators into pure-ASCII output", () => {
    const serialized = serializeInlineScriptValue({ note: "line para end" });
    // Raw separators are legal JSON but terminate JS string literals in some
    // parsers; both must leave as escape sequences.
    expect(serialized).not.toContain(" ");
    expect(serialized).not.toContain(" ");
    expect(serialized).toContain("\\u2028");
    expect(serialized).toContain("\\u2029");
    expect(serialized).toMatch(/^[\x20-\x7e]*$/);
  });

  it("round-trips values through JSON.parse unchanged", () => {
    for (const value of [
      null,
      true,
      42,
      -1.5,
      "",
      "plain",
      "</script>&  ",
      ["a", 1, null],
      { nested: { deep: ["<b>", "&amp;"] } },
      { unicode: "célestine 🌙" },
    ]) {
      expect(JSON.parse(serializeInlineScriptValue(value))).toEqual(value);
    }
  });

  it("keeps the app-frontend-hosting window-global injection shape terminator-free", () => {
    const attackerControlled = '</script><script>window.location="https://evil.test"';
    const literal = `window.__ELIZA_APP_API_BASE__ = ${serializeInlineScriptValue(attackerControlled)};`;
    expect(literal).not.toContain("</script");
    expect(literal).toContain("\\u003c/script\\u003e");
  });

  it("throws TypeError for values JSON cannot represent", () => {
    expect(() => serializeInlineScriptValue(undefined)).toThrow(TypeError);
    expect(() => serializeInlineScriptValue(() => "fn")).toThrow(TypeError);
    expect(() => serializeInlineScriptValue(Symbol("s"))).toThrow(TypeError);
  });
});
