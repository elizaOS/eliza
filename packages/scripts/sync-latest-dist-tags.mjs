#!/usr/bin/env node
/**
 * Reconciles the npm `latest` dist-tag for release-cohort packages that have
 * never shipped a stable version. Historical releases left `latest` pointing
 * at abandoned prerelease lines (for example 2.0.11-beta.7, published above
 * the line the repository actually advances), so a bare `npm install` fetches
 * a stale build. For prerelease-only packages the current `beta` channel is
 * the supported build, and `latest` is moved there when it lags or leads it.
 * Packages with any stable version published are never touched: their
 * `latest` belongs to the stable line and only a stable release may move it.
 *
 * Dry-run by default; pass --apply to execute `npm dist-tag add`. Requires
 * npm auth (NODE_AUTH_TOKEN via the workflow npmrc) only when applying.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { loadReleaseCohort } from "./lib/release-contract.mjs";
import { spawnSync } from "./lib/spawn-sync-captured.mjs";

const DEFAULT_REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function npmJson(args) {
  const result = spawnSync("npm", [...args, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    if (/E404/.test(`${result.stderr}`)) return null;
    throw new Error(
      `npm ${args.join(" ")} failed:\n${`${result.stderr}`.trim()}`,
    );
  }
  const stdout = `${result.stdout}`.trim();
  if (stdout.length === 0) return null;
  return JSON.parse(stdout);
}

function retagLatest(packageName, version) {
  const result = spawnSync(
    "npm",
    ["dist-tag", "add", `${packageName}@${version}`, "latest"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `npm dist-tag add ${packageName}@${version} latest failed:\n${`${result.stderr}`.trim()}`,
    );
  }
}

export function planLatestSync({ packageName, versions, distTags }) {
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const hasStable = versions.some((version) => !semver.prerelease(version));
  if (hasStable) return null;
  const beta = distTags?.beta;
  const latest = distTags?.latest;
  if (typeof beta !== "string" || !semver.valid(beta)) return null;
  if (latest === beta) return null;
  return { packageName, from: latest ?? "(unset)", to: beta };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const cohortPath = path.resolve(
    DEFAULT_REPO_ROOT,
    "packages/scripts/release-cohort.json",
  );
  const packageNames = loadReleaseCohort(cohortPath);
  const planned = [];
  for (const packageName of packageNames) {
    const versions = npmJson(["view", packageName, "versions"]);
    if (versions === null) {
      process.stdout.write(`${packageName}: not published, skipping\n`);
      continue;
    }
    const distTags = npmJson(["view", packageName, "dist-tags"]);
    const action = planLatestSync({
      packageName,
      versions: Array.isArray(versions) ? versions : [versions],
      distTags,
    });
    if (!action) continue;
    planned.push(action);
    process.stdout.write(
      `${packageName}: latest ${action.from} -> ${action.to}${apply ? "" : " (dry-run)"}\n`,
    );
    if (apply) retagLatest(packageName, action.to);
  }
  process.stdout.write(
    `${apply ? "Retagged" : "Would retag"} ${planned.length} of ${packageNames.length} cohort packages.\n`,
  );
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
