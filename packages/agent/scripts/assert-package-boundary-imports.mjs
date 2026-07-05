/**
 * Build-time guard: no relative import in packages/agent/src may resolve
 * outside the package root.
 *
 * A relative specifier that escapes the package (e.g.
 * "../../../core/src/services/message/mute-state.ts") pulls the sibling
 * package's TypeScript sources into this package's tsc program. Because those
 * files sit outside `rootDir`, tsc emits their .js/.d.ts NEXT TO the sources —
 * gitignored litter inside the sibling's src/ — and the emitted dist import
 * ("../../../core/src/....js") only resolves while that litter and the
 * sibling's src tree exist at runtime. Published or litter-cleaned installs
 * crash, and stale .js shadows .ts for every tool that resolves the sibling's
 * source (#13515). Cross-package code must come through the sibling's package
 * entry (e.g. "@elizaos/core"), which resolves to its built dist.
 *
 * Runs ahead of tsc in `build:dist` / `build:docker-dist`; the same walker is
 * asserted clean by src/__tests__/package-boundary-imports.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const agentPackageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

// `from "…"` (import/export/re-export), dynamic `import("…")`, and
// side-effect `import "…"` — only relative specifiers are captured.
const RELATIVE_SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["'](\.\.?\/[^"']*)["']/g;

function* walkSourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      yield* walkSourceFiles(full);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
    // Mirror the build program: tsconfig.build.json excludes test files, so
    // they never reach tsc emit and cannot litter a sibling package.
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    yield full;
  }
}

// Blank out comment content (newline-preserving, so reported line numbers stay
// accurate) — prose like `callers that import from "../../../../src/api/server"`
// must not read as a violation. The `[^:]` guard keeps "://" in string URLs
// from being treated as a line comment.
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:])\/\/[^\n]*/gm,
      (m, pre) => pre + " ".repeat(m.length - pre.length),
    );
}

/**
 * Scan every non-declaration .ts/.tsx under `packageRoot`/src and return each
 * relative import whose resolved path escapes `packageRoot`.
 */
export function findCrossPackageImports(packageRoot = agentPackageRoot) {
  const srcDir = path.join(packageRoot, "src");
  const violations = [];
  for (const file of walkSourceFiles(srcDir)) {
    const text = stripComments(readFileSync(file, "utf8"));
    const fileDir = path.dirname(file);
    for (const match of text.matchAll(RELATIVE_SPECIFIER_RE)) {
      const specifier = match[1];
      const resolved = path.resolve(fileDir, specifier);
      const relToPackage = path.relative(packageRoot, resolved);
      if (relToPackage.startsWith("..")) {
        const line = text.slice(0, match.index).split("\n").length;
        violations.push({
          file: path.relative(packageRoot, file),
          line,
          specifier,
        });
      }
    }
  }
  return violations;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const violations = findCrossPackageImports();
  if (violations.length > 0) {
    console.error(
      "✗ Relative imports escaping the package root (import via the sibling's package entry, e.g. @elizaos/core — a cross-package src import makes tsc emit .js litter into the sibling's src/ and the dist depend on it):",
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  "${v.specifier}"`);
    }
    process.exit(1);
  }
}
