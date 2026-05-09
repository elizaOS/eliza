#!/usr/bin/env bun
// P3 — Flip package.json main/module/types/exports from src/ to dist/.
//
// Affects every workspace package whose `main` (or top-level `exports."."`)
// currently points at a `src/` path. Those manifests are the source-of-truth
// committed shape; published shape is materialized by prepare-package-dist.mjs.
//
// What this script does NOT do:
//   - Doesn't run any builds. It assumes (or P2 has ensured) that builds emit
//     dist/index.js and dist/index.d.ts.
//   - Doesn't touch packages that already have main pointing at dist/.
//   - Doesn't rewrite root tsconfig.json paths (those stay src-pointing — see P5).

import { join, relative } from "node:path";
import {
  REPO_ROOT,
  Stats,
  makeLogger,
  parseFlags,
  preflight,
  walkWorkspacePackages,
  writeJson,
} from "./lib/util.mjs";

// Packages that this script should leave alone (e.g. virtual / template
// packages whose `src/` entry is intentional or untouchable).
const SKIP_PACKAGES = new Set([
  "__APP_NAME__",
  "__PLUGIN_NAME__",
  "__APP_PACKAGE_NAME__",
  "__ELECTROBUN_PACKAGE_NAME__",
  "__PROJECT_SLUG__",
  // Template files under packages/elizaos/templates/* aren't real packages
]);

async function main() {
  const flags = parseFlags();
  const log = makeLogger(flags);
  preflight("p3-flip-package-main", flags, log);
  const stats = new Stats();

  const pkgs = walkWorkspacePackages();
  log.info(`scanning ${pkgs.length} workspace packages`);

  for (const entry of pkgs) {
    if (SKIP_PACKAGES.has(entry.name)) continue;
    if (entry.dir.includes("/templates/")) continue;
    flipPackage(entry, flags, log, stats);
  }

  stats.print(log);
}

function flipPackage({ name, dir, packageJsonPath, pkg }, flags, log, stats) {
  let changed = false;
  const before = JSON.parse(JSON.stringify(pkg));

  // 1) main / module
  if (typeof pkg.main === "string" && isSrcPath(pkg.main)) {
    pkg.main = transformSrcToDist(pkg.main);
    changed = true;
  }
  if (typeof pkg.module === "string" && isSrcPath(pkg.module)) {
    pkg.module = transformSrcToDist(pkg.module);
    changed = true;
  }

  // 2) types
  if (typeof pkg.types === "string" && isSrcPath(pkg.types)) {
    pkg.types = transformSrcToDistDts(pkg.types);
    changed = true;
  } else if (pkg.types == null && typeof pkg.main === "string" && pkg.main.startsWith("./dist/")) {
    // No types declared but main is dist — set types to the matching .d.ts.
    pkg.types = pkg.main.replace(/\.(js|mjs|cjs)$/, ".d.ts");
    changed = true;
  }

  // 3) exports
  if (pkg.exports && typeof pkg.exports === "object") {
    const next = transformExports(pkg.exports);
    if (JSON.stringify(next) !== JSON.stringify(pkg.exports)) {
      pkg.exports = next;
      changed = true;
    }
  }

  // 4) ensure files: ["dist"] for npm publish hygiene
  if (Array.isArray(pkg.files)) {
    if (!pkg.files.includes("dist") && pkg.private !== true) {
      pkg.files = [...pkg.files, "dist"];
      changed = true;
    }
  } else if (pkg.private !== true && pkg.main?.startsWith("./dist/")) {
    pkg.files = ["dist"];
    changed = true;
  }

  if (!changed) return;

  log.info(`flip: ${name}`);
  if (flags.verbose) {
    if (before.main !== pkg.main) log.verbose(`  main:    ${before.main} → ${pkg.main}`);
    if (before.module !== pkg.module) log.verbose(`  module:  ${before.module} → ${pkg.module}`);
    if (before.types !== pkg.types) log.verbose(`  types:   ${before.types} → ${pkg.types}`);
  }
  writeJson(packageJsonPath, pkg, flags, log);
  stats.incr("packages flipped");
}

function isSrcPath(p) {
  if (typeof p !== "string") return false;
  return /^\.?\/?src\//.test(p) || p.startsWith("src/") || p === "src";
}

function transformSrcToDist(p) {
  // "src/index.ts"      → "./dist/index.js"
  // "./src/foo.tsx"     → "./dist/foo.js"
  // "src/lib/x.tsx"     → "./dist/lib/x.js"
  let out = p;
  if (!out.startsWith("./") && !out.startsWith("/")) out = `./${out}`;
  out = out.replace(/^\.\/src\//, "./dist/");
  out = out.replace(/\.(tsx?|jsx?|mts|cts|mjs)$/, ".js");
  return out;
}

function transformSrcToDistDts(p) {
  let out = p;
  if (!out.startsWith("./") && !out.startsWith("/")) out = `./${out}`;
  out = out.replace(/^\.\/src\//, "./dist/");
  out = out.replace(/\.(tsx?|jsx?|mts|cts|mjs)$/, ".d.ts");
  return out;
}

function transformExports(exports) {
  // Transforms every leaf value in the exports tree.
  // Handles:
  //   "./foo": "./src/foo.ts"
  //   "./foo": { types: "./src/foo.ts", import: "./src/foo.ts" }
  //   "./foo": { node: { types: "./src/foo.ts", default: "./src/foo.ts" } }
  if (typeof exports === "string") {
    if (isSrcPath(exports)) {
      // Heuristic: if the key was "./foo/bar.css", keep extension; else assume .js
      if (exports.endsWith(".css") || exports.endsWith(".json") || exports.endsWith(".scss")) {
        return exports.replace(/^\.\/src\//, "./dist/");
      }
      return transformSrcToDist(exports);
    }
    return exports;
  }
  if (exports && typeof exports === "object") {
    const out = {};
    for (const [key, val] of Object.entries(exports)) {
      // Map common condition keys
      if (key === "types" && typeof val === "string" && isSrcPath(val)) {
        out[key] = transformSrcToDistDts(val);
      } else if (typeof val === "string" && isSrcPath(val)) {
        out[key] = transformSrcToDist(val);
      } else {
        out[key] = transformExports(val);
      }
    }
    return out;
  }
  return exports;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
