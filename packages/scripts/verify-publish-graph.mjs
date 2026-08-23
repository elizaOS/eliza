#!/usr/bin/env node

/**
 * Verifies that every publishable workspace dependency can be installed from
 * the registry. `workspace:*` is rewritten to a concrete version in package
 * artifacts, so a dependency, optional dependency, or peer reference to a
 * private/missing workspace becomes an npm resolution failure for downstream
 * consumers even when every in-repository test is green.
 *
 * This is a direct invariant: there is no baseline or grandfathered edge.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { listPackages } from "./lib/workspaces.mjs";

const REGISTRY_RESOLVED_DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];

function isWorkspaceSpec(spec) {
  return typeof spec === "string" && spec.startsWith("workspace:");
}

function isPublishable(packageJson) {
  return Boolean(packageJson?.name) && packageJson.private !== true;
}

/**
 * Return every publishable-package edge that becomes unresolvable after the
 * workspace protocol is replaced with a registry version.
 */
export function findUnpublishableWorkspaceDependencies(packages) {
  const byName = new Map();
  for (const pkg of packages) {
    if (pkg.packageJson?.name) byName.set(pkg.packageJson.name, pkg);
  }

  const violations = [];
  for (const pkg of packages) {
    if (!isPublishable(pkg.packageJson)) continue;
    for (const field of REGISTRY_RESOLVED_DEPENDENCY_FIELDS) {
      for (const [dependency, spec] of Object.entries(
        pkg.packageJson[field] ?? {},
      )) {
        if (!isWorkspaceSpec(spec)) continue;
        const target = byName.get(dependency);
        if (!target) {
          violations.push({
            from: pkg.packageJson.name,
            fromDir: pkg.dir,
            field,
            dependency,
            spec,
            reason: "missing",
          });
        } else if (target.packageJson.private === true) {
          violations.push({
            from: pkg.packageJson.name,
            fromDir: pkg.dir,
            field,
            dependency,
            spec,
            reason: "private",
            targetDir: target.dir,
          });
        }
      }
    }
  }
  return violations;
}

export function formatPublishGraphViolation(violation) {
  const cause =
    violation.reason === "private"
      ? `target is private (${violation.targetDir}) and is not published`
      : "target is not a workspace package";
  return `  ${violation.from} (${violation.fromDir}) -> ${violation.field}["${violation.dependency}"]: ${violation.spec} — ${cause}`;
}

export class PublishGraphError extends Error {
  constructor(violations) {
    super(
      [
        `[publish-graph] ${violations.length} unpublishable workspace dependency edge(s) would break registry consumers:`,
        ...violations.map(formatPublishGraphViolation),
        "Fix the edge by making a deployment-only source package private, or by depending on a publishable package.",
      ].join("\n"),
    );
    this.name = "PublishGraphError";
    this.violations = violations;
  }
}

/** Fail fast on any invalid edge and return the checked package list. */
export function assertPublishableWorkspaceGraph(packages = listPackages()) {
  const violations = findUnpublishableWorkspaceDependencies(packages);
  if (violations.length > 0) throw new PublishGraphError(violations);
  return packages;
}

export function main() {
  const packages = assertPublishableWorkspaceGraph();
  const publishableCount = packages.filter((pkg) =>
    isPublishable(pkg.packageJson),
  ).length;
  console.log(
    `[publish-graph] OK — ${publishableCount} publishable workspace package(s) have registry-installable workspace dependencies.`,
  );
}

const invokedDirectly =
  import.meta.main ||
  (Boolean(process.argv[1]) &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
