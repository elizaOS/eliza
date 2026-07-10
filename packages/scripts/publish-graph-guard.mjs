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
 * checked-out package.json files. Run it in CI before any release cut.
 *
 * Usage:
 *   node packages/scripts/publish-graph-guard.mjs          # exit 1 on any violation
 */

import { listPackages } from "./lib/workspaces.mjs";

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

function main() {
  const violations = findDanglingWorkspaceDeps(listPackages());
  if (violations.length === 0) {
    console.log(
      "[publish-graph-guard] OK — no published package depends on an unpublishable workspace package.",
    );
    return;
  }
  console.error(
    `[publish-graph-guard] ${violations.length} unpublishable workspace dependency(ies) found — these 404 for external npm consumers (see #15833):`,
  );
  for (const v of violations) console.error(formatViolation(v));
  console.error(
    "\nFix: publish the target (remove `private: true`, add publishConfig/files) or drop it from the published package's runtime deps.",
  );
  process.exit(1);
}

if (import.meta.main) main();
