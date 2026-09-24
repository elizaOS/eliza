#!/usr/bin/env node

/**
 * scripts/check-upstream-drift.mjs
 *
 * Verifies that any explicitly pinned `@elizaos/*` dependency specs in the root package.json
 * match the actual version present in the vendored upstream checkouts.
 * Fails with an error if there is drift.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";
import {
  getElizaPackageLinks,
  getPluginPackageLinks,
  getPublishedElizaPackageSpecs,
} from "./setup-upstreams.mjs";

const ROOT = resolveRepoRootFromImportMeta(import.meta.url);

function readPackageJson(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function checkUpstreamDrift() {
  let hasDrift = false;

  // Get all explicitly pinned (non-workspace:*) @elizaos/* deps from root
  const pinnedDeps = getPublishedElizaPackageSpecs(ROOT);

  if (pinnedDeps.length === 0) {
    console.log(
      "[check-upstream-drift] No explicitly pinned @elizaos/* dependency specs found. Everything uses workspace:*. No drift possible.",
    );
    return;
  }

  console.log(
    `[check-upstream-drift] Found ${pinnedDeps.length} pinned @elizaos/* dependency spec(s). Verifying against vendored sources...`,
  );

  // Build a map of packageName -> local vendored directory
  const vendoredPackages = new Map();
  const elizaLinks = getElizaPackageLinks(ROOT);
  const pluginLinks = getPluginPackageLinks(ROOT);

  for (const link of [...elizaLinks, ...pluginLinks]) {
    // targetPath is the path to the actual package dir (e.g. ROOT/eliza/packages/core)
    // linkPath is where it gets symlinked (e.g. ROOT/node_modules/@elizaos/core)
    // We read from targetPath to get the truth.
    const pkg = readPackageJson(link.targetPath);
    if (pkg?.name) {
      vendoredPackages.set(pkg.name, {
        dir: link.targetPath,
        version: pkg.version,
      });
    }
  }

  for (const [packageName, specVersion] of pinnedDeps) {
    const localSource = vendoredPackages.get(packageName);
    if (!localSource) {
      console.warn(
        `[check-upstream-drift] WARNING: Pinned package ${packageName}@${specVersion} is not vendored locally.`,
      );
      continue;
    }

    if (localSource.version !== specVersion) {
      console.error(
        `[check-upstream-drift] ERROR: Drift detected in ${packageName}!`,
      );
      console.error(`  - Root dependency spec: ${specVersion}`);
      console.error(
        `  - Vendored source version: ${localSource.version} (at ${path.relative(ROOT, localSource.dir)})`,
      );
      hasDrift = true;
    } else {
      console.log(
        `[check-upstream-drift] OK: ${packageName} matches vendored version (${specVersion}).`,
      );
    }
  }

  if (hasDrift) {
    console.error(
      "\n[check-upstream-drift] FAILED: Upstream drift detected. Please align root package.json dependency specs with vendored package.json versions.",
    );
    process.exit(1);
  } else {
    console.log(
      "\n[check-upstream-drift] PASS: All vendored versions match dependency specs exactly.",
    );
  }
}

checkUpstreamDrift();
