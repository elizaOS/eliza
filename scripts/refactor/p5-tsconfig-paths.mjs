#!/usr/bin/env bun
// P5 — tsconfig paths.
//
// Goals:
//   - Keep the root tsconfig.json paths pointing at src/ (fast IDE/typecheck).
//   - Rename tsconfig.workspace-paths.json → tsconfig.dist-paths.json and
//     expand it to cover every built workspace package.
//   - Add a `typecheck:dist` turbo task / npm script that uses the dist paths.
//     This becomes the contract test that catches drift between src and dist.
//
// What this script does NOT touch:
//   - Per-package tsconfig.json files (they keep src paths for dev).
//   - Per-package tsconfig.build.json files (they already point at dist; will
//     be audited separately).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  REPO_ROOT,
  Stats,
  makeLogger,
  moveFile,
  parseFlags,
  preflight,
  readJson,
  walkWorkspacePackages,
  writeFileIfChanged,
  writeJson,
} from "./lib/util.mjs";

const OLD_PATHS = "tsconfig.workspace-paths.json";
const NEW_PATHS = "tsconfig.dist-paths.json";

async function main() {
  const flags = parseFlags();
  const log = makeLogger(flags);
  preflight("p5-tsconfig-paths", flags, log);
  const stats = new Stats();

  log.section("1. Rename tsconfig.workspace-paths.json → tsconfig.dist-paths.json");
  const oldAbs = join(REPO_ROOT, OLD_PATHS);
  const newAbs = join(REPO_ROOT, NEW_PATHS);
  if (existsSync(oldAbs)) {
    moveFile(oldAbs, newAbs, flags, log);
    stats.incr("file renamed");
  } else {
    log.note(`${OLD_PATHS} not found; will create ${NEW_PATHS} fresh`);
  }

  log.section("2. Rewrite tsconfig extends that referenced workspace-paths");
  rewriteWorkspacePathReferences(flags, log, stats);

  log.section("3. Build comprehensive dist-paths config");
  const distPaths = buildDistPaths();
  log.info(`generating paths for ${Object.keys(distPaths).length / 2} packages`);
  const distConfig = {
    $schema: "https://json.schemastore.org/tsconfig",
    extends: "./tsconfig.json",
    compilerOptions: {
      paths: distPaths,
    },
    include: [
      "packages/*/src/**/*",
      "packages/native-plugins/*/src/**/*",
      "plugins/*/*.ts",
      "plugins/*/src/**/*",
      "plugins/*/typescript/**/*.ts",
      "cloud/packages/*/src/**/*",
    ],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*.stories.ts",
      "**/*.stories.tsx",
      "**/__tests__/**",
    ],
  };
  writeFileIfChanged(
    newAbs,
    `${JSON.stringify(distConfig, null, 2)}\n`,
    flags,
    log,
  );
  stats.incr("dist-paths entries", Object.keys(distPaths).length);

  log.section("4. Add typecheck:dist npm script + turbo task");
  const rootPkgPath = join(REPO_ROOT, "package.json");
  const rootPkg = readJson(rootPkgPath);
  rootPkg.scripts = rootPkg.scripts ?? {};
  if (!rootPkg.scripts["typecheck:dist"]) {
    rootPkg.scripts["typecheck:dist"] =
      "tsc --noEmit -p tsconfig.dist-paths.json";
    log.info("add script: typecheck:dist");
    writeJson(rootPkgPath, rootPkg, flags, log);
    stats.incr("root scripts added");
  }

  log.section("5. Note: per-package tsconfigs keep src paths");
  log.note(
    "Root tsconfig.json keeps `paths` pointing at src/ for fast in-repo dev.",
  );
  log.note(
    "Use `bun run typecheck` for normal dev; `bun run typecheck:dist` to verify the built shape.",
  );

  stats.print(log);
}

function buildDistPaths() {
  const paths = {};
  const pkgs = walkWorkspacePackages();
  for (const { name, dir, pkg } of pkgs) {
    if (!name.startsWith("@elizaos/") && !name.startsWith("@babylon/")) continue;
    if (pkg.private === true) continue;
    // Only emit paths for packages that have or expect to have a built dist
    const hasBuild = Boolean(pkg.scripts?.build);
    if (!hasBuild) continue;
    const rel = relativeRepoPath(dir);
    // primary entry
    paths[name] = [`./${rel}/dist/index.d.ts`];
    // wildcard
    paths[`${name}/*`] = [`./${rel}/dist/*`];
  }
  return paths;
}

function relativeRepoPath(absDir) {
  return absDir.replace(`${REPO_ROOT}/`, "").replace(/\\/g, "/");
}

function rewriteWorkspacePathReferences(flags, log, stats) {
  const files = walkJsonFiles(REPO_ROOT);
  let changed = 0;
  for (const file of files) {
    const before = readFileSync(file, "utf8");
    if (!before.includes(OLD_PATHS)) continue;
    const after = before.replaceAll(OLD_PATHS, NEW_PATHS);
    writeFileIfChanged(file, after, flags, log);
    changed++;
  }
  stats.incr("tsconfig references rewritten", changed);
}

function walkJsonFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkJsonFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      out.push(full);
    }
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
