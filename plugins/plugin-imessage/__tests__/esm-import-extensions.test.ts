/**
 * This plugin is built by `tsc` only (see build.ts): the emitted `dist/*.js`
 * keeps every relative import specifier exactly as written in `src`. Node ESM
 * resolves `./types.js`, not `./types`, so a bare relative import type-checks
 * and passes unit tests but makes the published plugin fail to load.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "../src");
const RELATIVE_SPECIFIER = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

describe("published ESM output", () => {
  it("names the .js file in every relative import so Node can resolve the tsc output", () => {
    const bare: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(RELATIVE_SPECIFIER)) {
        const specifier = match[1];
        if (!/\.(?:js|json|node)$/.test(specifier)) {
          bare.push(`${path.relative(SRC, file)} -> ${specifier}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });
});
