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
 * Separately, it runs Tarjan's SCC over the whole package.json workspace graph
 * and fails on any dependency cycle — the transitive A->B->C->A shape included,
 * not just direct A<->B pairs (the gap that let #15422 regress silently). A
 * short, ratcheted allowlist keeps known pre-existing multi-node cycles green
 * while they are driven to zero.
 *
 * Exits non-zero on PHANTOM edges or uncovered dependency cycles so it can gate
 * CI / `verify` without false-flagging correct dynamic-load edges.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTurboNonImportedBuildDepOwners } from "./lib/script-metadata.mjs";
import { listPackages } from "./lib/workspaces.mjs";

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

// Multi-node workspace cycles that predate full-SCC detection, kept green while
// they are driven to zero (follow-up #15439). Each key is the cycle's members
// sorted and joined with "|" — stable regardless of which edge or rotation the
// finder reports. This is a ratchet, not an amnesty: a cycle NOT listed here
// fails the audit, and new entries must never be added — fix the edge instead.
const KNOWN_WORKSPACE_CYCLES = new Set([
  "@elizaos/agent|@elizaos/app-core|@elizaos/plugin-inbox",
]);

const workspaceDepsByPackage = new Map();
for (const [name, dir] of WORKSPACE_DIRS.entries()) {
  let pkg;
  try {
    pkg = readJson(path.join(dir, "package.json"));
  } catch {
    continue;
  }
  workspaceDepsByPackage.set(
    name,
    new Set(
      [...declaredDeps(pkg)].filter(
        (dep) => WORKSPACE_DIRS.has(dep) && dep !== name,
      ),
    ),
  );
}

// Tarjan's strongly-connected-components over the package.json graph. Every SCC
// with more than one member is a dependency cycle — including the transitive
// A->B->C->A shape a pairwise A<->B scan misses, which is exactly how the
// cloud-shared -> plugin-elizacloud -> ui -> cloud-shared cycle regressed
// silently (#15422). Iterative (explicit stack) because the workspace graph is
// deep enough that recursion risks a call-stack overflow on some Node builds.
function findWorkspaceStronglyConnectedComponents(graph) {
  let counter = 0;
  const index = new Map();
  const lowlink = new Map();
  const onStack = new Set();
  const tarjanStack = [];
  const components = [];

  for (const root of graph.keys()) {
    if (index.has(root)) continue;
    const work = [
      { node: root, neighbors: [...(graph.get(root) ?? [])], i: 0 },
    ];
    while (work.length) {
      const frame = work[work.length - 1];
      const { node } = frame;
      if (frame.i === 0) {
        index.set(node, counter);
        lowlink.set(node, counter);
        counter++;
        tarjanStack.push(node);
        onStack.add(node);
      }
      if (frame.i < frame.neighbors.length) {
        const next = frame.neighbors[frame.i];
        frame.i++;
        if (!graph.has(next)) continue;
        if (!index.has(next)) {
          work.push({
            node: next,
            neighbors: [...(graph.get(next) ?? [])],
            i: 0,
          });
        } else if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node), index.get(next)));
        }
        continue;
      }
      if (lowlink.get(node) === index.get(node)) {
        const component = [];
        let w;
        do {
          w = tarjanStack.pop();
          onStack.delete(w);
          component.push(w);
        } while (w !== node);
        if (component.length > 1) components.push(component);
      }
      work.pop();
      if (work.length) {
        const parent = work[work.length - 1].node;
        lowlink.set(parent, Math.min(lowlink.get(parent), lowlink.get(node)));
      }
    }
  }
  return components;
}

// Walk the lowest-sorted in-component out-edge from each node until a node
// repeats, yielding one concrete, deterministic cycle path for the message.
function describeCycle(component) {
  const inComponent = new Set(component);
  const path = [];
  const seen = new Set();
  let node = [...component].sort()[0];
  while (!seen.has(node)) {
    seen.add(node);
    path.push(node);
    node = [...(workspaceDepsByPackage.get(node) ?? [])]
      .filter((dep) => inComponent.has(dep))
      .sort()[0];
  }
  return [...path.slice(path.indexOf(node)), node];
}

const workspaceCycles = [];
for (const component of findWorkspaceStronglyConnectedComponents(
  workspaceDepsByPackage,
)) {
  const key = [...component].sort().join("|");
  if (KNOWN_WORKSPACE_CYCLES.has(key)) continue;
  workspaceCycles.push(
    component.length === 2
      ? `${[...component].sort().join(" <-> ")}`
      : describeCycle(component).join(" -> "),
  );
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
    `[audit-turbo-build-deps] ${workspaceCycles.length} workspace package dependency cycle(s):\n`,
  );
  for (const cycle of workspaceCycles) console.error(`  ✗ ${cycle}`);
  console.error(
    "\nA package.json dependency cycle makes Turbo build-order inference unstable\n(the whole cycle rebuilds as one unit). Break one edge: drop it if production\nsource never imports it, relocate the shared type/constant to a leaf package,\nor move a genuine runtime edge behind a dynamic import.",
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
console.log(
  "[audit-turbo-build-deps] ✓ no workspace package dependency cycles (outside the tracked baseline)",
);
