/**
 * Guard against cross-package src relative imports (#13515).
 *
 * A production source in packages/agent that statically imports a sibling
 * package's src via a relative path (e.g. `../../../core/src/...`) compiles
 * "successfully" under `tsc --noCheck`, but because the pulled-in sources sit
 * outside the agent program's rootDir, tsc emits the sibling package's
 * compiled .js files NEXT TO their .ts sources — gitignored .js litter inside
 * packages/core/src and packages/shared/src — and the emitted dist then
 * depends on that litter existing at runtime. This is the known ".js litter
 * shadows .ts" failure signature that has previously broken live deployments.
 *
 * All such symbols are exported from the package barrels (`@elizaos/core`,
 * `@elizaos/shared`), so a deep relative import is never needed. This test
 * fails on ANY static import/export-from specifier in production agent
 * sources that resolves outside packages/agent. Tests are excluded (they are
 * never compiled into dist) and dynamic-import fallback path strings (e.g.
 * the plugin-sql source-checkout fallback in runtime/eliza.ts) are not import
 * specifiers and are unaffected.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "../..");
const srcRoot = path.join(packageRoot, "src");

function isProductionSource(filePath: string): boolean {
  if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) return false;
  if (filePath.endsWith(".test.ts") || filePath.endsWith(".test.tsx"))
    return false;
  if (filePath.endsWith(".d.ts")) return false;
  const rel = path.relative(srcRoot, filePath);
  if (rel.split(path.sep).includes("__tests__")) return false;
  return true;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      walk(full, out);
    } else if (isProductionSource(full)) {
      out.push(full);
    }
  }
  return out;
}

// Static import/export-from specifiers only. Dynamic import(...) of computed
// strings and bare path.resolve(...) arguments are intentionally not matched.
const SPECIFIER_RE =
  /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*["'](\.\.?\/[^"']+)["']|(?:^|\n)\s*import\s*["'](\.\.?\/[^"']+)["']/g;

describe("packages/agent production sources", () => {
  test("no static relative import escapes the package root", () => {
    const offenders: string[] = [];

    for (const file of walk(srcRoot)) {
      const content = readFileSync(file, "utf8");
      for (const match of content.matchAll(SPECIFIER_RE)) {
        const specifier = match[1] ?? match[2];
        if (!specifier) continue;
        const resolved = path.resolve(path.dirname(file), specifier);
        const relToPackage = path.relative(packageRoot, resolved);
        if (relToPackage.startsWith("..")) {
          offenders.push(
            `${path.relative(packageRoot, file)} -> ${specifier} (resolves outside packages/agent)`,
          );
        }
      }
    }

    expect(
      offenders,
      `Cross-package src relative imports found. Import from the package barrel ` +
        `(@elizaos/core, @elizaos/shared, ...) instead — deep relative imports make ` +
        `tsc emit .js litter into the sibling package's src tree and produce dist ` +
        `output that depends on that litter at runtime (#13515):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
