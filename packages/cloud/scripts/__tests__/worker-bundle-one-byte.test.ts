/**
 * Proves the one-byte bundle rewrite keeps what the program computes. Each
 * module runs in its own Node process (the engine family workerd shares)
 * before and after the rewrite, and every export is compared: regular
 * expressions by pattern text, flags, toString() and what they match,
 * functions by what they return. Bun is not used for evaluation because its
 * transpiler rewrites String.raw text.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "../../../scripts/lib/spawn-sync-captured.ts";
import {
  OneByteRefusal,
  shiftSourceMapColumns,
  toOneByteBundle,
} from "../worker-bundle-one-byte.ts";

// Cooked templates: the module text holds the characters themselves, as
// wrangler's output does.
const REGEXPS = `
export const vi = /(?:mỗi|hàng|hằng)\\s*(?:ngày|tuần)/i;
export const tail = /[\\s.!?…–—-]*[✅🎉]*$/u;
export const astral = /🎉+/;
export const astralClass = /^[🎉👍]$/;
export const identity = /isn\\’t/;
export const sets = /^[\\p{L}’\\-]+$/v;
export const named = /(?<ŝ>[–—])\\k<ŝ>/du;
export const quotes = /[“”]"\\/’/g;
export const returned = () => { return/—/u.test("—") };
export const afterBlock = () => { let r; { r = 1 } /—/.test("—") ? r = 2 : r = 3; return r; };
export const typed = () => typeof/—/;
export const arrow = ((s) => /—/g)("x");
export const fresh = () => { const out = []; for (let i = 0; i < 2; i++) out.push(/—/g); return out[0] !== out[1]; };
`;

const LITERALS = `
export const plain = "q’ \\’"; // trailing — comment
export const continued = "a\\\u2028b";
export const cooked = \`storage — native put \${2}🎉 \\’\`;
/* block — comment */
`;

const VIEW = `
const probes = ["mỗi ngày", "HÀNG tuần", "hằng  ngày", "done…✅🎉", "done—", "🎉🎉",
  "🎉", "👍", "\\uD83C", "isn’t", "isnt", "you’re 🎉", "Łódź’s", "a\\uDF89", "––", "—–",
  "“q”\\"/’", "q’"];
const regExpPrototype = Object.getPrototypeOf(/x/);
const view = (value) => {
  if (Object.prototype.toString.call(value) === "[object RegExp]") {
    return {
      source: value.source, flags: value.flags, text: String(value),
      intrinsic: Object.getPrototypeOf(value) === regExpPrototype,
      matches: probes.map((probe) => {
        value.lastIndex = 0;
        const match = value.exec(probe);
        return match && { all: [...match], index: match.index, groups: match.groups ?? null };
      }),
    };
  }
  if (typeof value === "function") {
    try { return { returned: view(value()) }; } catch (error) { return { threw: String(error) }; }
  }
  if (Array.isArray(value)) return value.map(view);
  return value;
};
const exports = await import(process.argv[2]);
console.log(JSON.stringify(Object.keys(exports).sort().map((key) => [key, view(exports[key])])));
`;

function exportsOf(dir: string, name: string, source: string): unknown {
  writeFileSync(join(dir, name), source);
  return JSON.parse(
    execFileSync("node", [join(dir, "view.mjs"), join(dir, name)], {
      encoding: "utf8",
    }),
  );
}

/** Rewrites `module`, checks it is one-byte, and compares its exports. */
function rewriteAndCompare(module: string): string {
  const { source } = toOneByteBundle(module);
  expect([...source].every((char) => char.charCodeAt(0) <= 0xff)).toBe(true);
  const dir = mkdtempSync(join(tmpdir(), "one-byte-"));
  try {
    writeFileSync(join(dir, "view.mjs"), VIEW);
    const before = exportsOf(dir, "before.mjs", module);
    expect(exportsOf(dir, "after.mjs", source)).toEqual(before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return source;
}

function refusedSites(module: string): string[] {
  try {
    toOneByteBundle(module);
  } catch (error) {
    if (error instanceof OneByteRefusal) {
      return error.refusals.map((refusal) => refusal.site);
    }
    throw error;
  }
  return [];
}

const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const vlq = (value: number) => {
  let rest = value * 2;
  let text = "";
  do {
    text += BASE64[(rest % 32) | (rest >= 32 ? 32 : 0)];
    rest = Math.floor(rest / 32);
  } while (rest > 0);
  return text;
};
const generatedColumns = (line: string) => {
  const columns: number[] = [];
  let column = 0;
  for (const segment of line.split(",").filter(Boolean)) {
    let value = 0;
    let shift = 0;
    for (const char of segment) {
      const digit = BASE64.indexOf(char);
      value += (digit & 31) * 2 ** shift;
      shift += 5;
      if (!(digit & 32)) break;
    }
    column += value % 2 ? -(value - 1) / 2 : value / 2;
    columns.push(column);
  }
  return columns;
};

describe("toOneByteBundle", () => {
  it("keeps the pattern text, flags and matches of regular expressions", () => {
    const source = rewriteAndCompare(REGEXPS);
    expect(source.startsWith("var __oneByteRegExp=RegExp;")).toBe(true);
    expect(source).toContain(
      'identity = new __oneByteRegExp("isn\\\\\\u2019t","")',
    );
    expect(source).toContain("return new __oneByteRegExp(");
  });

  it("keeps string, template and comment values", () => {
    const source = rewriteAndCompare(LITERALS);
    expect(source).toContain("/* block \\u2014 comment */");
  });

  it("keeps a line terminator in a comment, so ASI does not change", () => {
    const source = rewriteAndCompare(`
export const returns = () => { return /*\u2028*/ 1; };
export const continues = () => {
  const seen = []; let outer = 0;
  outer: for (const i of [1, 2]) for (const j of [1, 2]) { seen.push(i * 10 + j); continue /*\u2028*/ outer; }
  return seen;
};
export const breaks = () => {
  let n = 0; let done = 0;
  done: for (const i of [1, 2]) for (const j of [1, 2]) { n++; break /*\u2028*/ done; }
  return n;
};
`);
    expect(source).toContain("return /*\n*/ 1;");
    expect(
      rewriteAndCompare(`
export const postfix = () => { let a = 1, b = 2; a /*\u2028*/ ++b; return [a, b]; };
export const lineComment = () => { return // ends at U+2028:\u2028 1
};
`),
    ).toContain("ends at U+2028:\n 1");
  });

  it("captures the RegExp intrinsic before bundle code can replace it", () => {
    rewriteAndCompare(`
globalThis.RegExp = class NotRegExp {};
export const late = () => /—/u;
`);
    const source = rewriteAndCompare(
      "export const __oneByteRegExp = 1; export const r = /—/;",
    );
    expect(source.startsWith("var __oneByteRegExp1=RegExp;")).toBe(true);
  });

  it("refuses every tagged template, String.raw included", () => {
    for (const unsafe of [
      "export const x = String.raw`—`;",
      "export const shadowedParameter = (String) => String.raw`—`;",
      "const String = { raw: (s) => s.raw[0] }; export const x = String.raw`—`;",
      "String.raw = (s, ...v) => [s.raw, v]; export const x = String.raw`—`;",
      'Object.defineProperty(String, "raw", { get: () => (s) => s.raw }); export const x = String.raw`—`;',
      "const raw = String.raw; export const x = raw`—`;",
      "const tag = (s) => s.raw[0]; export const x = tag`—`;",
    ]) {
      const sites = refusedSites(unsafe);
      expect(sites.length).toBeGreaterThan(0);
      expect(sites.every((site) => site.startsWith("tagged-template"))).toBe(
        true,
      );
    }
  });

  it("refuses regular expressions without a provable RegExp intrinsic", () => {
    for (const unsafe of [
      "var r = /—/;",
      "const RegExp = class {}; export const r = /—/;",
      "export function f(RegExp) { return /—/; }",
      "#!/usr/bin/env node\nexport const r = /—/;",
    ]) {
      expect(refusedSites(unsafe)).toEqual([expect.stringMatching(/^regexp:/)]);
    }
  });

  it("refuses identifiers, legal and source-map comments and stray whitespace", () => {
    expect(refusedSites("export const ŝ = 1;")).toEqual(["identifier"]);
    expect(refusedSites("/*! © Łukasz */ export const a = 1;")).toEqual([
      "legal-comment",
    ]);
    expect(refusedSites("/** @license Ł */ export const a = 1;")).toEqual([
      "legal-comment",
    ]);
    expect(refusedSites("export const a = 1;\n//# sourceURL=ŝ.js")).toEqual([
      "source-map-comment",
    ]);
    expect(refusedSites("export const a = 1;\u3000")).toEqual(["whitespace"]);
    expect(refusedSites("export const f = () => /*\r\u2028*/ 1;")).toEqual([
      "comment-line-terminator:after-carriage-return",
    ]);
  });

  it("leaves a one-byte bundle untouched", () => {
    const source = "export const a = /x/;\n";
    expect(toOneByteBundle(source)).toMatchObject({ source, escaped: 0 });
  });
});

describe("shiftSourceMapColumns", () => {
  it("keeps every mapped column on the same code", () => {
    const module = REGEXPS + LITERALS.replace("\\\u2028", "");
    const { source, edits } = toOneByteBundle(module);
    const before = module.split("\n");
    const after = source.split("\n");
    expect(after).toHaveLength(before.length);
    // A segment at every column, alternately with and without a source.
    const mappings = before
      .map((line) =>
        [...Array(line.length).keys()]
          .map(
            (column) =>
              (column === 0 ? vlq(0) : vlq(1)) + (column % 2 ? "AAA" : ""),
          )
          .join(","),
      )
      .join(";");
    const shifted = shiftSourceMapColumns(mappings, module, edits);
    expect(shifted.replace(/[^;]/g, "")).toBe(mappings.replace(/[^;]/g, ""));
    const offsets = (lines: string[], line: number) =>
      lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
    shifted.split(";").forEach((line, index) => {
      const columns = generatedColumns(line);
      expect(columns).toHaveLength(before[index].length);
      const lineOffset = offsets(before, index);
      columns.forEach((column, original) => {
        const offset = lineOffset + original;
        if (edits.some((edit) => edit.start <= offset && offset < edit.end)) {
          return;
        }
        expect(after[index][column]).toBe(before[index][original]);
      });
      // The source fields after the generated column are kept as they were.
      expect(
        line
          .split(",")
          .filter(Boolean)
          .map((s) => s.endsWith("AAA")),
      ).toEqual(
        Array.from({ length: before[index].length }, (_, c) => c % 2 === 1),
      );
    });
  });

  it("refuses a source whose line breaks generators count differently", () => {
    expect(() =>
      shiftSourceMapColumns("AAAA", "export const a = '\u2028';", []),
    ).toThrow(OneByteRefusal);
  });
});
