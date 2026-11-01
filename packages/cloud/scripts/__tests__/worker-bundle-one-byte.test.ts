/**
 * Proves the one-byte bundle rewrite keeps runtime values identical. Node (the
 * engine family workerd shares) evaluates each module before and after the
 * rewrite; regular expressions are compared by what they match. Bun is not
 * used for evaluation because its transpiler rewrites String.raw text.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "../../../scripts/lib/spawn-sync-captured.ts";
import { OneByteRefusal, toOneByteBundle } from "../worker-bundle-one-byte.ts";

// A cooked template: Bun may escape these characters, but the string value
// keeps them, as wrangler's output does.
const MODULE = `
const kai = "\\\\s*";
export const vi = /(?:mỗi|hàng|hằng)\\s*(?:ngày|tuần)/i;
export const tail = /[\\s.!?…–—-]*[✅🎉]*$/u;
export const astral = /🎉+/;
export const astralClass = /^[🎉👍]$/;
export const identity = /isn\\’t/;
export const sets = /^[\\p{L}’\\-]+$/v;
export const raw = new RegExp(String.raw\`(?:you['’]re)\${kai}[✅🎉]*\`, "u");
export const rawText = String.raw\`a\\n’\${1}🎉\`;
export const cooked = \`storage — native put \${2}🎉\`;
export const plain = "q’"; // trailing — comment
/*! © Łukasz — legal comment */
`;

const COMPARE = `
const probes = ["mỗi ngày", "HÀNG tuần", "hằng  ngày", "done…✅🎉", "done—", "🎉🎉",
  "🎉", "👍", "\\uD83C", "isn’t", "isnt", "you’re 🎉", "you're✅", "Łódź’s", "a\\uDF89"];
const view = (v) => v instanceof RegExp
  ? { flags: v.flags, matches: probes.map((p) => p.match(v)?.[0] ?? null) } : v;
const [before, after] = await Promise.all(process.argv.slice(2).map((f) => import(f)));
const keys = Object.keys(before).sort();
console.log(JSON.stringify({
  keys: JSON.stringify(keys) === JSON.stringify(Object.keys(after).sort()),
  differing: keys.filter((k) => JSON.stringify(view(before[k])) !== JSON.stringify(view(after[k]))),
}));
`;

describe("toOneByteBundle", () => {
  it("removes every code unit above U+00FF without changing exports", () => {
    const { source, escaped } = toOneByteBundle(MODULE);
    expect(escaped).toBe(
      MODULE.split("").filter((unit) => unit.charCodeAt(0) > 0xff).length,
    );
    expect([...source].every((char) => char.charCodeAt(0) <= 0xff)).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "one-byte-"));
    try {
      writeFileSync(join(dir, "before.mjs"), MODULE);
      writeFileSync(join(dir, "after.mjs"), source);
      writeFileSync(join(dir, "compare.mjs"), COMPARE);
      const result = JSON.parse(
        execFileSync(
          "node",
          [
            join(dir, "compare.mjs"),
            join(dir, "before.mjs"),
            join(dir, "after.mjs"),
          ],
          { encoding: "utf8" },
        ),
      );
      expect(result).toEqual({ keys: true, differing: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses text a tag or an identifier could observe", () => {
    for (const unsafe of [
      "const tag = (s) => s.raw[0]; export const x = tag`—`;",
      "export const ŝ = 1;",
    ]) {
      expect(() => toOneByteBundle(unsafe)).toThrow(OneByteRefusal);
    }
  });
});
