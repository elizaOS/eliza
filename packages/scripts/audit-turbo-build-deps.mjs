#!/usr/bin/env node
/**
 * Validates explicit Turbo build dependencies, task owners and workspace cycles.
 * Builds must name declared or source-referenced dependencies. Source-based
 * typechecks may also need declarations from transitive workspace dependencies;
 * the TypeScript resolution audit verifies that their required builds run first.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTurboNonImportedBuildDepOwners } from "./lib/script-metadata.ts";
import { listPackages } from "./lib/workspaces.ts";

const repoRoot = path.resolve(
  process.env.AUDIT_TURBO_REPO_ROOT ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
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

/** Workspace package names that participate in build order. */
function buildGraphDeps(pkg) {
  const names = new Set();
  for (const field of [
    "dependencies",
    "devDependencies",
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
 * `(?![\w-])` stops `@elizaos/app` from matching `@elizaos/app-tools`.
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
// statically import — real build relationships a source scan cannot see, so
// their named edges are not phantom drift. Each owner opts in via
// `elizaos.scripts.turboNonImportedBuildDeps` in its own package.json; resolved
// through the discovery seam so no owner names live in this file.
const ALLOW_OWNERS = resolveTurboNonImportedBuildDepOwners({ repoRoot });

const turbo = readJson(path.join(repoRoot, "turbo.json"));
const tasks = turbo.tasks ?? {};

const phantomTaskOverrides = [];
const phantoms = [];
const undeclared = [];
const redundant = [];
const workspaceCycles = [];

const workspaceDepsByPackage = new Map();
const declaredDepsByPackage = new Map();
for (const [name, dir] of WORKSPACE_DIRS.entries()) {
  let pkg;
  try {
    pkg = readJson(path.join(dir, "package.json"));
  } catch {
    continue;
  }
  declaredDepsByPackage.set(name, declaredDeps(pkg));
  workspaceDepsByPackage.set(
    name,
    new Set([...buildGraphDeps(pkg)].filter((dep) => WORKSPACE_DIRS.has(dep))),
  );
}

function findStronglyConnectedComponents(graph) {
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indexes = new Map();
  const lowLinks = new Map();
  const components = [];

  function visit(node) {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    const deps = [...(graph.get(node) ?? [])].sort();
    for (const dep of deps) {
      if (!graph.has(dep)) continue;
      if (!indexes.has(dep)) {
        visit(dep);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(dep)));
      } else if (onStack.has(dep)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(dep)));
      }
    }

    if (lowLinks.get(node) !== indexes.get(node)) return;

    const component = [];
    while (stack.length) {
      const member = stack.pop();
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  }

  for (const node of [...graph.keys()].sort()) {
    if (!indexes.has(node)) visit(node);
  }

  return components;
}

function formatCyclePath(component, graph) {
  if (component.length === 2) {
    return [...component].sort().join(" <-> ");
  }

  const allowed = new Set(component);
  for (const start of [...component].sort()) {
    const pending = [{ node: start, path: [start], seen: new Set([start]) }];
    while (pending.length) {
      const { node, path: currentPath, seen } = pending.pop();
      const deps = [...(graph.get(node) ?? [])]
        .filter((dep) => allowed.has(dep))
        .sort()
        .reverse();
      for (const dep of deps) {
        if (dep === start) return [...currentPath, start].join(" -> ");
        if (seen.has(dep)) continue;
        pending.push({
          node: dep,
          path: [...currentPath, dep],
          seen: new Set([...seen, dep]),
        });
      }
    }
  }
  const sorted = [...component].sort();
  return `${sorted.join(" -> ")} -> ${sorted[0]}`;
}

for (const component of findStronglyConnectedComponents(
  workspaceDepsByPackage,
)) {
  if (component.length <= 1) continue;
  workspaceCycles.push(formatCyclePath(component, workspaceDepsByPackage));
}

for (const [taskName, def] of Object.entries(tasks)) {
  const separator = taskName.lastIndexOf("#");
  if (separator !== -1) {
    const owner = taskName.slice(0, separator);
    const scriptName = taskName.slice(separator + 1);
    const ownerDir = resolvePackageDir(owner);
    if (!ownerDir) {
      phantomTaskOverrides.push(
        `${taskName} — owner package is not a workspace member`,
      );
    } else {
      try {
        const pkg = readJson(path.join(ownerDir, "package.json"));
        if (!Object.hasOwn(pkg.scripts ?? {}, scriptName)) {
          phantomTaskOverrides.push(
            `${taskName} — owner package does not define script "${scriptName}"`,
          );
        }
      } catch {
        phantomTaskOverrides.push(
          `${taskName} — owner package.json could not be read`,
        );
      }
    }
  }

  if (separator === -1) continue;
  const owner = taskName.slice(0, separator);
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
  if (taskName.endsWith("#typecheck")) {
    for (const dependency of declared) {
      for (const transitive of declaredDepsByPackage.get(dependency) ?? []) {
        declared.add(transitive);
      }
    }
  }

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
if (workspaceCycles.length) {
  console.error(
    `[audit-turbo-build-deps] ${workspaceCycles.length} workspace package cycle(s):\n`,
  );
  for (const cycle of workspaceCycles) console.error(`  ✗ ${cycle}`);
  console.error(
    "\nA package.json cycle makes Turbo build-order inference unstable.\nMove one build-order edge behind a host external, runtime dynamic import, or remove it if production source does not import it.",
  );
  process.exit(1);
}
if (phantomTaskOverrides.length) {
  console.error(
    `[audit-turbo-build-deps] ${phantomTaskOverrides.length} phantom pkg#task override(s):\n`,
  );
  for (const p of phantomTaskOverrides) console.error(`  ✗ ${p}`);
  console.error(
    "\nA phantom override names a package task whose owner package does not provide that script.\nRemove the dead turbo.json override or restore the package script.",
  );
  process.exit(1);
}
console.log("[audit-turbo-build-deps] ✓ no phantom #build dependency edges");
console.log("[audit-turbo-build-deps] ✓ no phantom pkg#task overrides");
console.log("[audit-turbo-build-deps] ✓ no workspace package cycles");
