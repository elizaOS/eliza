#!/usr/bin/env node
/**
 * Audit hand-maintained `<pkg>#build` `dependsOn` overrides in turbo.json
 * (issue #9626). The generic `build` task derives its graph from package.json
 * via `["@elizaos/core#build", "^build"]` and never drifts. Per-package
 * overrides that enumerate explicit `@elizaos/X#build` deps DO drift: they
 * accrete names of packages that were renamed, removed, or never actually
 * depended on — forcing Turbo to build unrelated packages and obscuring the
 * real graph.
 *
 * For every override that names explicit `<dep>#build` entries, this classifies
 * each named dep against the owner package:
 *   - PHANTOM    — not in package.json deps AND never referenced in src/** .
 *                  A dead edge. FAILS the audit.
 *   - UNDECLARED — referenced in src/** (static import or dynamic/string) but
 *                  missing from package.json. The turbo edge is correct; the
 *                  fix is to ADD the package.json dependency, not drop the edge.
 *                  Reported as a warning (does not fail) — a dynamic-load
 *                  harness (e.g. scenario-runner) legitimately references a
 *                  plugin by name without a static import.
 *   - REDUNDANT  — a real dependency already covered by a co-listed `^build`.
 *                  Reported as info (the override could be simplified).
 *
 * Exits non-zero only on PHANTOM edges so it can gate CI / `verify` without
 * false-flagging correct dynamic-load edges.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackages } from "./lib/workspaces.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

/**
 * Map every named workspace package → its absolute directory in THIS repo (not
 * node_modules, which in a worktree may symlink elsewhere). Discovery is the
 * shared seam; unnamed private packages carry no `#build` override to audit.
 */
function buildWorkspaceMap() {
  const map = new Map();
  for (const pkg of listPackages({ repoRoot })) {
    if (pkg.name) map.set(pkg.name, path.join(repoRoot, pkg.dir));
  }
  return map;
}

const WORKSPACE_DIRS = buildWorkspaceMap();

/** Resolve a workspace package name to its directory in this repo. */
function resolvePackageDir(name) {
  return WORKSPACE_DIRS.get(name) ?? null;
}

/** All dependency names declared in a package.json (any field). */
function declaredDeps(pkg) {
  const names = new Set();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const dep of Object.keys(pkg[field] ?? {})) names.add(dep);
  }
  return names;
}

const SRC_EXT = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
]);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `needle` (a package name) appear as a whole package reference in the
 * package's source? A package name in an import/config is always followed by a
 * quote, slash, or backtick — never another name char — so the lookahead
 * `(?![\w-])` stops `@elizaos/app` from matching `@elizaos/app-core`.
 */
function referencedInSource(dir, needle) {
  const re = new RegExp(`${escapeRegExp(needle)}(?![\\w-])`);
  const roots = [path.join(dir, "src")];
  // also scan top-level entry/bundler-config files some packages use instead
  // of (or alongside) src/ — a bundler config legitimately references the
  // packages it copies/bundles without a runtime import.
  let topLevel;
  try {
    topLevel = readdirSync(dir, { withFileTypes: true });
  } catch {
    topLevel = [];
  }
  for (const ent of topLevel) {
    if (!ent.isFile()) continue;
    if (/^(index|build|.*\.config)\.(ts|mts|cts|js|mjs|cjs)$/.test(ent.name)) {
      roots.push(path.join(dir, ent.name));
    }
  }
  const stack = [...roots];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = statSync(cur);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      for (const ent of readdirSync(cur, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name === "dist") continue;
        stack.push(path.join(cur, ent.name));
      }
      continue;
    }
    if (!SRC_EXT.has(path.extname(cur))) continue;
    let body;
    try {
      body = readFileSync(cur, "utf8");
    } catch {
      continue;
    }
    if (re.test(body)) return true;
  }
  return false;
}

// Owners whose `#build` override deliberately enumerates packages it does not
// statically import — these are real build relationships a source scan cannot
// see, so their named edges are not phantom drift. Keep this list short and
// justified.
const ALLOW_OWNERS = new Set([
  // build script delegates to the chat example via a relative path
  // (`bun run --cwd ../chat build`), so the package name never appears in src.
  "@elizaos/example-form",
  // bundles the model plugins into the extension at build time (referenced by
  // the extension's build config / manifest, not a src import).
  "@elizaos/example-browser-extension",
  // the scenario harness builds the connector/runtime plugins it loads
  // dynamically when executing scenarios; they are not statically imported.
  "@elizaos/scenario-runner",
  // the desktop shell bundles the app renderer's built dist by filesystem
  // path (electrobun.config.ts reads `packages/app/dist`), so @elizaos/app is
  // a real build edge with no package-name import.
  "@elizaos/electrobun",
]);

const turbo = readJson(path.join(repoRoot, "turbo.json"));
const tasks = turbo.tasks ?? {};

const phantoms = [];
const undeclared = [];
const redundant = [];

for (const [taskName, def] of Object.entries(tasks)) {
  if (!taskName.endsWith("#build")) continue;
  if (taskName === "build") continue; // the generic task, not an override
  const owner = taskName.slice(0, -"#build".length);
  const deps = def.dependsOn ?? [];
  const named = deps.filter((d) => d.endsWith("#build") && !d.startsWith("^"));
  if (named.length === 0) continue;
  const hasWildcard = deps.includes("^build");

  if (ALLOW_OWNERS.has(owner)) continue;
  const ownerDir = resolvePackageDir(owner);
  if (!ownerDir) continue; // non-resolvable (e.g. virtual root) — skip
  let pkg;
  try {
    pkg = readJson(path.join(ownerDir, "package.json"));
  } catch {
    continue;
  }
  const declared = declaredDeps(pkg);

  for (const dep of named) {
    const depName = dep.slice(0, -"#build".length);
    if (depName === owner) continue;
    const isDeclared = declared.has(depName);
    if (isDeclared) {
      // A real dep already pulled in by ^build is a redundant override entry.
      const isRegularDep = pkg.dependencies?.[depName] !== undefined;
      if (hasWildcard && isRegularDep && depName !== "@elizaos/core") {
        redundant.push(
          `${owner}: ${depName}#build is already covered by ^build`,
        );
      }
      continue;
    }
    // Not declared. core is the universal base — every package needs it built
    // first regardless of whether it's a direct dep, so don't flag it.
    if (depName === "@elizaos/core") continue;
    if (referencedInSource(ownerDir, depName)) {
      undeclared.push(
        `${owner}: ${depName}#build — imported in src but missing from package.json (add the dependency)`,
      );
    } else {
      phantoms.push(
        `${owner}: ${depName}#build — not a dependency and never referenced in src (dead edge)`,
      );
    }
  }
}

if (undeclared.length) {
  console.warn(
    `[audit-turbo-build-deps] ${undeclared.length} undeclared-dependency edge(s) (warning):`,
  );
  for (const u of undeclared) console.warn(`  ! ${u}`);
  console.warn("");
}
if (redundant.length) {
  console.warn(
    `[audit-turbo-build-deps] ${redundant.length} redundant override entr(ies) (info):`,
  );
  for (const r of redundant) console.warn(`  · ${r}`);
  console.warn("");
}
if (phantoms.length) {
  console.error(
    `[audit-turbo-build-deps] ${phantoms.length} phantom #build edge(s):\n`,
  );
  for (const p of phantoms) console.error(`  ✗ ${p}`);
  console.error(
    "\nA phantom edge names a package the owner neither depends on nor references.\nRemove it from the turbo.json override (the generic `^build` derives real deps).",
  );
  process.exit(1);
}
console.log("[audit-turbo-build-deps] ✓ no phantom #build dependency edges");
