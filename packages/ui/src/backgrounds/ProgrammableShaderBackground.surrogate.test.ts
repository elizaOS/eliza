/**
 * Regression for the shipped `shaderCompileFallbackReason` in
 * ProgrammableShaderBackground: a driver compile log is untrusted UTF-16, so the
 * excerpt it puts in the fallback reason must never carry a lone surrogate —
 * neither one already present in the log nor one manufactured by cutting a
 * surrogate pair at the length cap. Exercises the real exported helper (the
 * component's own call site) rather than a copy of the logic.
 */
import { describe, expect, it } from "vitest";
import { shaderCompileFallbackReason } from "./ProgrammableShaderBackground";

const PREFIX = "compile: ";

/** The compile-log excerpt the component would surface for `log`. */
function excerptFor(log: string): string {
  const reason = shaderCompileFallbackReason(log);
  expect(reason.startsWith(PREFIX)).toBe(true);
  return reason.slice(PREFIX.length);
}

/** Every UTF-16 code unit in the surrogate range, paired or not. */
function surrogateCodeUnits(text: string): number[] {
  const found: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) found.push(code);
  }
  return found;
}

describe("shaderCompileFallbackReason", () => {
  it("replaces a lone surrogate sitting on the truncation boundary", () => {
    const log = `${"a".repeat(199)}\uD800${"b".repeat(10)}`;

    // Pre-change behaviour, kept as the contrast: a plain slice keeps the lone
    // high surrogate as the final code unit.
    expect(log.slice(0, 200).charCodeAt(199)).toBe(0xd800);

    const excerpt = excerptFor(log);
    expect(excerpt.length).toBe(200);
    expect(excerpt.charCodeAt(199)).toBe(0xfffd);
    expect(surrogateCodeUnits(excerpt)).toEqual([]);
  });

  it("never splits an astral pair straddling the cap", () => {
    const log = `${"x".repeat(199)}\u{1F98A}${"y".repeat(10)}`;

    expect(log.slice(0, 200).charCodeAt(199)).toBe(0xd83e);

    const excerpt = excerptFor(log);
    expect(excerpt).toBe("x".repeat(199));
    expect(surrogateCodeUnits(excerpt)).toEqual([]);
  });

  it("caps a long log at 200 code units and passes short logs through", () => {
    expect(excerptFor("a".repeat(500))).toBe("a".repeat(200));
    expect(excerptFor("ERROR: 0:3 syntax error")).toBe(
      "ERROR: 0:3 syntax error",
    );
  });
});
