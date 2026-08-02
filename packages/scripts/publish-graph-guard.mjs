#!/usr/bin/env node

/**
 * Fails when an about-to-be-published workspace package depends, via a
 * `workspace:*` pin, on a package that will never reach npm — because the
 * target is `"private": true` or is absent from the workspace set entirely.
 *
 * The publish pipeline (lerna / publish-from-dist.mjs) rewrites every
 * `workspace:*` spec to the concrete release version at pack time. A private or
 * unknown target then becomes a dangling `@scope/name@<version>` reference that
 * resolves fine in-repo (bun's workspace linking) but 404s for every external
 * `npm install` of the published artifact. That is invisible to in-repo lanes
 * and only bites real consumers — the exact failure mode of issue #15833, where
 * published `@elizaos/shared` carried `@elizaos/registry: workspace:*` while
 * `@elizaos/registry` was `private: true` and never published.
 *
 * The check is deterministic and network-free: "publishable" means the repo
 * ships it (`private !== true`), so the whole graph is decidable from the
 * checked-out package.json files. It runs before any release cut — wired into
 * the nightly publish job and the `publish-from-dist.mjs` preflight.
 *
 * The graph has pre-existing dangling edges beyond the #15833 registry fix
 * (private cloud-shared / feed-* pins). Failing on all
 * of them would leave the gate permanently red and unusable, so accepted edges
 * live in `publish-graph-baseline.json`: the guard fails only on a NEW edge not
 * in the baseline, and on a baseline entry that no longer dangles (ratchet down
 * — never add entries to silence a regression, fix the edge).
 *
 * Entrypoint note: this must fire under both `node` and `bun`. `import.meta.main`
 * only exists on Node >= 24.2 (and the repo's `engines.node` allows 24.0/24.1),
 * so the bare `import.meta.main` gate was a silent no-op under `node` — the exact
 * command CI and the root `audit:publish-graph` script use (#15939). The argv
 * comparison below is the repo-standard fallback.
 *
 * Usage:
 *   node packages/scripts/publish-graph-guard.mjs          # exit 1 on any NEW violation
 *   PUBLISH_GRAPH_BASELINE=<path> node …                   # override baseline (tests)
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackages } from "./lib/workspaces.mjs";

const DEFAULT_BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "publish-graph-baseline.json",
);

// npm installs `dependencies` and `optionalDependencies` transitively for a
// consumer; a dangling pin in either breaks resolution. `peerDependencies` are
// supplied by the consumer, `devDependencies` never ship, so both are excluded.
const RESOLVED_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies"];

function isWorkspaceSpec(versionSpec) {
  return (
    typeof versionSpec === "string" && versionSpec.startsWith("workspace:")
  );
}

function isPublishable(packageJson) {
  return Boolean(packageJson?.name) && packageJson.private !== true;
}

/**
 * Walk the publishable packages and return every `workspace:*` dependency whose
 * target is not itself publishable. Each violation names the depending package,
 * the field, the dependency, and why it dangles (`private` or `missing`).
 *
 * Pure over its `packages` input (`{ name, dir, packageJson }[]`) so the guard
 * logic is testable against synthetic graphs with no filesystem.
 */
export function findDanglingWorkspaceDeps(packages) {
  const byName = new Map();
  for (const pkg of packages) {
    if (pkg.packageJson?.name) byName.set(pkg.packageJson.name, pkg);
  }

  const violations = [];
  for (const pkg of packages) {
    if (!isPublishable(pkg.packageJson)) continue;
    for (const field of RESOLVED_DEPENDENCY_FIELDS) {
      const deps = pkg.packageJson[field];
      if (!deps) continue;
      for (const [depName, versionSpec] of Object.entries(deps)) {
        if (!isWorkspaceSpec(versionSpec)) continue;
        const target = byName.get(depName);
        if (!target) {
          violations.push({
            from: pkg.packageJson.name,
            fromDir: pkg.dir,
            field,
            dependency: depName,
            spec: versionSpec,
            reason: "missing",
          });
        } else if (target.packageJson.private === true) {
          violations.push({
            from: pkg.packageJson.name,
            fromDir: pkg.dir,
            field,
            dependency: depName,
            spec: versionSpec,
            reason: "private",
            targetDir: target.dir,
          });
        }
      }
    }
  }
  return violations;
}

export function formatViolation(v) {
  const cause =
    v.reason === "private"
      ? `target is "private": true (${v.targetDir}) and is never published`
      : "target is not a workspace package (dangling reference)";
  return `  ${v.from} (${v.fromDir}) -> ${v.field}["${v.dependency}"]: ${v.spec} — ${cause}`;
}

// A violation's identity is (depending package, field, dependency); dirs/spec
// are informational. The baseline and the live graph are matched on this key so
// an edge is recognised regardless of whether its target is `private` vs newly
// `missing`. Space is a safe separator: npm package names and package.json
// dependency-field names can never contain one, so the key stays unambiguous
// while remaining grep-able plain text.
export function violationKey(v) {
  return `${v.from} ${v.field} ${v.dependency}`;
}

/**
 * Load the accepted-edge keys from `publish-graph-baseline.json`. A missing file
 * yields an empty set — the strictest reading (every live edge is a regression),
 * so an accidentally-deleted baseline fails closed rather than masking edges.
 */
export function loadBaselineKeys(baselinePath = DEFAULT_BASELINE_PATH) {
  let raw;
  try {
    raw = readFileSync(baselinePath, "utf8");
  } catch (err) {
    // error-policy:J4 absent baseline => strict (empty) gate, never a fake pass
    if (err?.code === "ENOENT") return new Set();
    throw err;
  }
  const parsed = JSON.parse(raw);
  const edges = Array.isArray(parsed.edges) ? parsed.edges : [];
  return new Set(edges.map((e) => `${e.from} ${e.field} ${e.dependency}`));
}

/**
 * Partition live violations against the baseline: `newViolations` are edges to
 * reject (fail the gate), `baselined` are accepted pre-existing edges, and
 * `stale` are baseline keys that no longer dangle and must be removed to ratchet
 * the gate down. Pure over its inputs so the gate decision is testable.
 */
export function classifyViolations(violations, baselineKeys) {
  const matched = new Set();
  const newViolations = [];
  const baselined = [];
  for (const v of violations) {
    const key = violationKey(v);
    if (baselineKeys.has(key)) {
      baselined.push(v);
      matched.add(key);
    } else {
      newViolations.push(v);
    }
  }
  const stale = [...baselineKeys].filter((key) => !matched.has(key));
  return { newViolations, baselined, stale };
}

/**
 * Run the guard over a package graph (defaults to the live workspace) and
 * classify against the baseline. Returns the decision without exiting so the
 * publish pipeline (`publish-from-dist.mjs`) and tests can consume it directly;
 * `main()` is the process wrapper that prints and sets the exit code.
 */
export function runGuard({
  baselinePath = DEFAULT_BASELINE_PATH,
  packages,
} = {}) {
  const violations = findDanglingWorkspaceDeps(packages ?? listPackages());
  const { newViolations, baselined, stale } = classifyViolations(
    violations,
    loadBaselineKeys(baselinePath),
  );
  return {
    ok: newViolations.length === 0 && stale.length === 0,
    newViolations,
    baselined,
    stale,
  };
}

function main() {
  const baselinePath = process.env.PUBLISH_GRAPH_BASELINE
    ? path.resolve(process.env.PUBLISH_GRAPH_BASELINE)
    : DEFAULT_BASELINE_PATH;
  const { ok, newViolations, baselined, stale } = runGuard({ baselinePath });

  if (newViolations.length > 0) {
    console.error(
      `[publish-graph-guard] ${newViolations.length} NEW unpublishable workspace dependency(ies) — these 404 for external npm consumers (see #15833):`,
    );
    for (const v of newViolations) console.error(formatViolation(v));
    console.error(
      "\nFix: publish the target (remove `private: true`, add publishConfig/files) or drop it from the published package's runtime deps. Do NOT add it to the baseline.",
    );
  }
  if (stale.length > 0) {
    console.error(
      `[publish-graph-guard] ${stale.length} baseline entry(ies) no longer dangle — remove them from publish-graph-baseline.json to ratchet the gate down:`,
    );
    for (const key of stale)
      console.error(`  ${key.split(" ").join(' -> "')}"`);
  }
  if (!ok) process.exit(1);

  console.log(
    `[publish-graph-guard] OK — no NEW unpublishable workspace dependency (${baselined.length} pre-existing edge(s) baselined as #15833 follow-up).`,
  );
}

// Fire under both `node` and `bun`: `import.meta.main` is undefined on
// Node < 24.2 (silent no-op — #15939), so fall back to the repo-standard argv
// comparison. `path.resolve` normalises a relative `process.argv[1]`.
const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedDirectly) main();
