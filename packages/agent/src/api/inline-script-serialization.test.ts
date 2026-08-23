/**
 * Coverage for `serializeInlineScriptValue`, the encoder that turns server
 * values into JavaScript literals inside HTML `<script>` elements. JSON
 * quoting alone does not stop a literal `</script>` from closing the element.
 * Drive the real module: no mocks.
 */
import { describe, expect, it } from "vitest";
import { serializeInlineScriptValue } from "./inline-script-serialization.ts";

function parseSerialized(serialized: string): unknown {
  return JSON.parse(serialized);
}

describe("serializeInlineScriptValue", () => {
  it("serializes JSON primitives, empty containers, and a single-element payload", () => {
    expect(serializeInlineScriptValue(null)).toBe("null");
    expect(serializeInlineScriptValue(true)).toBe("true");
    expect(serializeInlineScriptValue(false)).toBe("false");
    expect(serializeInlineScriptValue(0)).toBe("0");
    expect(serializeInlineScriptValue(-0)).toBe("0");
    expect(serializeInlineScriptValue(42)).toBe("42");
    expect(serializeInlineScriptValue(1.5)).toBe("1.5");
    expect(serializeInlineScriptValue("")).toBe('""');
    expect(serializeInlineScriptValue("hello")).toBe('"hello"');
    expect(serializeInlineScriptValue([])).toBe("[]");
    expect(serializeInlineScriptValue({})).toBe("{}");
    expect(serializeInlineScriptValue(["only"])).toBe('["only"]');
    expect(serializeInlineScriptValue({ only: 1 })).toBe('{"only":1}');
  });

  it("stringifies NaN and ±Infinity as null, matching JSON", () => {
    expect(serializeInlineScriptValue(Number.NaN)).toBe("null");
    expect(serializeInlineScriptValue(Number.POSITIVE_INFINITY)).toBe("null");
    expect(serializeInlineScriptValue(Number.NEGATIVE_INFINITY)).toBe("null");
  });

  it("omits undefined object fields and turns undefined array holes into null", () => {
    expect(serializeInlineScriptValue({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(serializeInlineScriptValue([1, undefined, 3])).toBe("[1,null,3]");
  });

  it("throws TypeError when JSON.stringify yields undefined", () => {
    const message = "Inline script values must be JSON-serializable";
    expect(() => serializeInlineScriptValue(undefined)).toThrowError(TypeError);
    expect(() => serializeInlineScriptValue(undefined)).toThrowError(message);
    expect(() => serializeInlineScriptValue(() => "nope")).toThrowError(
      TypeError,
    );
    expect(() => serializeInlineScriptValue(() => "nope")).toThrowError(
      message,
    );
    expect(() => serializeInlineScriptValue(Symbol("x"))).toThrowError(
      TypeError,
    );
    expect(() => serializeInlineScriptValue(Symbol("x"))).toThrowError(message);
  });

  it("lets JSON.stringify TypeErrors surface for BigInt and cycles", () => {
    expect(() => serializeInlineScriptValue(1n)).toThrowError(TypeError);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => serializeInlineScriptValue(cyclic)).toThrowError(TypeError);
  });

  it("escapes & < > so a payload cannot terminate an HTML script element", () => {
    expect(serializeInlineScriptValue("</script>")).toBe(
      '"\\u003c/script\\u003e"',
    );
    expect(serializeInlineScriptValue("</SCRIPT>")).toBe(
      '"\\u003c/SCRIPT\\u003e"',
    );
    expect(serializeInlineScriptValue("</sCrIpT>")).toBe(
      '"\\u003c/sCrIpT\\u003e"',
    );
    expect(serializeInlineScriptValue("<")).toBe('"\\u003c"');
    expect(serializeInlineScriptValue(">")).toBe('"\\u003e"');
    expect(serializeInlineScriptValue("&")).toBe('"\\u0026"');
    expect(serializeInlineScriptValue("a&b<c>d")).toBe(
      '"a\\u0026b\\u003cc\\u003ed"',
    );
    expect(serializeInlineScriptValue("<<>>&&")).toBe(
      '"\\u003c\\u003c\\u003e\\u003e\\u0026\\u0026"',
    );
  });

  it("escapes the same characters inside object keys and nested values", () => {
    const payload = {
      "a<b": "c&d",
      nested: { inner: "</script>", amp: "x&y" },
    };
    const serialized = serializeInlineScriptValue(payload);
    expect(serialized).toBe(
      '{"a\\u003cb":"c\\u0026d","nested":{"inner":"\\u003c/script\\u003e","amp":"x\\u0026y"}}',
    );
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain(">");
    expect(serialized).not.toContain("&");
    expect(parseSerialized(serialized)).toEqual(payload);
  });

  it("applies replacements globally rather than stopping at the first match", () => {
    const serialized = serializeInlineScriptValue(
      "</script></script>&<&><script>",
    );
    expect(serialized).toBe(
      '"\\u003c/script\\u003e\\u003c/script\\u003e\\u0026\\u003c\\u0026\\u003e\\u003cscript\\u003e"',
    );
  });

  it("does not leave U+2028 or U+2029 as raw line terminators in the output", () => {
    const lineSeparator = "\u2028";
    const paragraphSeparator = "\u2029";
    const mixed = `keep${lineSeparator}and${paragraphSeparator}end`;

    const serializedLine = serializeInlineScriptValue(lineSeparator);
    const serializedParagraph = serializeInlineScriptValue(paragraphSeparator);
    const serializedMixed = serializeInlineScriptValue(mixed);

    expect(serializedLine).not.toContain(lineSeparator);
    expect(serializedParagraph).not.toContain(paragraphSeparator);
    expect(serializedMixed).not.toContain(lineSeparator);
    expect(serializedMixed).not.toContain(paragraphSeparator);
    expect(parseSerialized(serializedLine)).toBe(lineSeparator);
    expect(parseSerialized(serializedParagraph)).toBe(paragraphSeparator);
    expect(parseSerialized(serializedMixed)).toBe(mixed);
  });

  it("round-trips JSON-serializable values, including boot-config shaped objects", () => {
    const bootOverrides = {
      apiBase: "https://example.invalid/base",
      webPushVapidPublicKey: "vapid-public",
    };
    const token = "tok_live_not-a-secret-for-this-test";
    expect(parseSerialized(serializeInlineScriptValue(bootOverrides))).toEqual(
      bootOverrides,
    );
    expect(parseSerialized(serializeInlineScriptValue(token))).toBe(token);
    expect(
      parseSerialized(
        serializeInlineScriptValue({
          apiBase: "https://x.example/</script>?q=1&b=2",
        }),
      ),
    ).toEqual({ apiBase: "https://x.example/</script>?q=1&b=2" });
  });

  it("escapes toJSON results the same way as ordinary values", () => {
    const hostile = {
      toJSON() {
        return "</script>&";
      },
    };
    const serialized = serializeInlineScriptValue(hostile);
    expect(serialized).toBe('"\\u003c/script\\u003e\\u0026"');
    expect(parseSerialized(serialized)).toBe("</script>&");
  });

  it("produces a JS-literal-safe encoding for the static-file-server injection shape", () => {
    const bootOverrides = {
      apiBase: "https://evil.example/</script><script>alert(1)</script>",
    };
    const serialized = serializeInlineScriptValue(bootOverrides);
    expect(serialized.toLowerCase()).not.toContain("</script");
    expect(serialized).not.toContain("<");
    expect(serialized).not.toContain("&");
    const recovered = Function(`"use strict"; return (${serialized});`)() as {
      apiBase: string;
    };
    expect(recovered).toEqual(bootOverrides);
  });
});
