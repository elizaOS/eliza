#!/usr/bin/env node
/**
 * Rewrites extensionless relative imports in emitted package dist/*.js so Node ESM
 * can resolve them (tsc with moduleResolution "bundler" often omits .js specifiers).
 *
 * Usage: node scripts/rewrite-dist-relative-imports-node-esm.mjs <package-dir-relative-to-repo-root>
 *
 * For each relative specifier ./ or ../ that has no file extension, resolves to either
 * "<path>.js" or "<path>/index.js" when those files exist next to the importing file.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function shouldSkipSpecifier(spec) {
  if (!(spec.startsWith("./") || spec.startsWith("../"))) return true;
  if (spec === "." || spec === "..") return true;
  const base = path.posix.basename(spec);
  if (base.includes(".")) return true;
  return false;
}

function resolveTarget(importDir, specifier) {
  const abs = path.resolve(importDir, specifier);
  if (existsSync(`${abs}.js`) && statSync(`${abs}.js`).isFile()) {
    return `${specifier}.js`;
  }
  try {
    if (existsSync(abs) && statSync(abs).isDirectory()) {
      const indexJs = path.join(abs, "index.js");
      if (existsSync(indexJs) && statSync(indexJs).isFile()) {
        return `${specifier.replace(/\/$/, "")}/index.js`;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

const FROM_RE =
  /\b(from|import)\s+["'](\.[^"']+)["']|\bimport\s*\(\s*["'](\.[^"']+)["']\s*\)/g;

function rewriteFileContents(filePath) {
  const importDir = path.dirname(filePath);
  let source = readFileSync(filePath, "utf8");
  let changed = false;

  source = source.replace(FROM_RE, (full, kw, spec1, spec2) => {
    const spec = spec1 ?? spec2;
    const isDynamic = spec2 !== undefined && spec1 === undefined;
    if (shouldSkipSpecifier(spec)) {
      return full;
    }
    const resolved = resolveTarget(importDir, spec);
    if (!resolved || resolved === spec) {
      return full;
    }
    changed = true;
    if (isDynamic) {
      return `import("${resolved}")`;
    }
    const quoteMatch = full.match(/(["'])(\.\.?[^"']+)\1/);
    const quote = quoteMatch?.[1] ?? '"';
    return `${kw} ${quote}${resolved}${quote}`;
  });

  if (changed) {
    writeFileSync(filePath, source, "utf8");
  }
}

function walkJs(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walkJs(full, visit);
    } else if (ent.isFile() && ent.name.endsWith(".js")) {
      visit(full);
    }
  }
}

const packageDirArg = process.argv[2];
if (!packageDirArg) {
  console.error(
    "usage: node scripts/rewrite-dist-relative-imports-node-esm.mjs <package-dir>",
  );
  process.exit(1);
}

const distDir = path.join(repoRoot, packageDirArg, "dist");
if (!existsSync(distDir)) {
  console.error(`[rewrite-dist-relative-imports-node-esm] dist not found: ${distDir}`);
  process.exit(1);
}

walkJs(distDir, (filePath) => {
  rewriteFileContents(filePath);
});
