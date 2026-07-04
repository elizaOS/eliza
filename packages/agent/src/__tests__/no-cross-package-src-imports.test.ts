/**
 * Build-boundary guard: no source file that reaches the agent dist may import
 * another package's `src/` via a relative path. `build:dist` transpiles per
 * file (tsc `rewriteRelativeImportExtensions`), so a specifier like
 * `../../../core/src/x.ts` survives into `dist/` as `../../../core/src/x.js`
 * — a path that only exists as gitignored build litter in the sibling
 * package's `src/` (core ignores emitted `.js` under `src/`) and never exists
 * at all in the published layout (core ships `dist` only). A clean checkout +
 * build then fails at import time. Cross-package symbols must come through
 * the package's public exports (`@elizaos/core`, ...) instead.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(here, "..");
const PACKAGE_DIR = path.resolve(SRC_DIR, "..");

/**
 * Pre-existing offenders (baseline debt, must never grow). Each entry needs
 * its target exported from every core entry (node/browser/edge) before it can
 * move to `@elizaos/core` — relationships-graph-builder is node-entry-only
 * today and relationships-graph.ts is reachable from the mobile bundle.
 */
const KNOWN_OFFENDERS = new Set(["services/relationships-graph.ts"]);

/** Matches static import/export-from and dynamic import specifiers. */
const SPECIFIER_RE = /(?:\bfrom\s*|\bimport\s*\(\s*)["']([^"']+)["']/g;

/**
 * Comments may quote import statements as prose (api/server.ts does); strip
 * them so only live code is scanned. Naive stripping cannot corrupt a real
 * specifier: relative import paths never contain `//` or block-comment
 * delimiters.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      out.push(...walkSources(full));
    } else if (
      /\.(ts|tsx|mts|cts)$/.test(entry.name) &&
      !/\.test\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out;
}

function escapingSpecifiers(filePath: string): string[] {
  const source = stripComments(readFileSync(filePath, "utf8"));
  const dir = path.dirname(filePath);
  const escapes: string[] = [];
  for (const match of source.matchAll(SPECIFIER_RE)) {
    const specifier = match[1];
    if (!specifier.startsWith(".")) continue;
    const resolved = path.resolve(dir, specifier);
    if (
      resolved !== PACKAGE_DIR &&
      !resolved.startsWith(PACKAGE_DIR + path.sep)
    ) {
      escapes.push(specifier);
    }
  }
  return escapes;
}

describe("agent build boundary", () => {
  it("has no relative imports escaping packages/agent (ratchet)", () => {
    const offenders: string[] = [];
    for (const file of walkSources(SRC_DIR)) {
      const escapes = escapingSpecifiers(file);
      if (escapes.length === 0) continue;
      const rel = path.relative(SRC_DIR, file);
      if (KNOWN_OFFENDERS.has(rel)) continue;
      offenders.push(`${rel}: ${escapes.join(", ")}`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps the known-offender baseline honest", () => {
    const stale = [...KNOWN_OFFENDERS].filter((rel) => {
      try {
        return escapingSpecifiers(path.join(SRC_DIR, rel)).length === 0;
      } catch {
        return true; // error-policy:J3 missing file = stale entry, report it
      }
    });
    expect(
      stale,
      `remove fixed entries from KNOWN_OFFENDERS: ${stale.join(", ")}`,
    ).toEqual([]);
  });
});
