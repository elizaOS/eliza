#!/usr/bin/env bun
/**
 * publish-from-dist.mjs
 *
 * Publishes workspace packages from their prepared npm package directory.
 * Packages that generate dist/package.json are published from dist/ because
 * prepare-package-dist.mjs contains:
 *   - main / types / exports pointing at compiled outputs
 *   - workspace:* deps rewritten to real semver
 *
 * Packages without dist/package.json are published from the package root after
 * workspace deps have been rewritten by scripts/replace-workspace-versions.js.
 *
 * Lerna's default behavior publishes from the package root, which sees the
 * source-of-truth package.json (workspace:* + src/ pointers). This script
 * replaces that step.
 *
 * Usage:
 *   bun scripts/publish-from-dist.mjs             # dry-run
 *   bun scripts/publish-from-dist.mjs --apply     # actual publish
 *   bun scripts/publish-from-dist.mjs --apply --tag beta
 *   bun scripts/publish-from-dist.mjs --apply --filter @elizaos/core,@elizaos/shared
 *   bun scripts/publish-from-dist.mjs --apply --otp 123456
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs() {
  const argv = process.argv.slice(2);
  const flags = {
    apply: argv.includes("--apply"),
    tag: undefined,
    filter: undefined,
    otp: undefined,
  };
  const tagIdx = argv.indexOf("--tag");
  if (tagIdx >= 0) flags.tag = argv[tagIdx + 1];
  const filterIdx = argv.indexOf("--filter");
  if (filterIdx >= 0) flags.filter = argv[filterIdx + 1].split(",").map((s) => s.trim());
  const otpIdx = argv.indexOf("--otp");
  if (otpIdx >= 0) flags.otp = argv[otpIdx + 1];
  return flags;
}

const PACKAGE_ROOTS = [
  "packages",
  "packages/native-plugins",
  "packages/app-core/platforms",
  "plugins",
  "cloud/packages",
];

function walkPackages() {
  const out = new Map();
  for (const glob of PACKAGE_ROOTS) {
    const base = join(REPO_ROOT, glob);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (entry.name.startsWith(".")) continue;
      const dir = join(base, entry.name);
      const pkgPath = join(dir, "package.json");
      if (!existsSync(pkgPath)) continue;
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name && pkg.private !== true) {
          out.set(pkg.name, { name: pkg.name, dir, version: pkg.version });
        }
      } catch {}
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const flags = parseArgs();
  const pkgs = walkPackages();
  const filtered = flags.filter
    ? pkgs.filter((p) => flags.filter.includes(p.name))
    : pkgs;

  console.log(`${flags.apply ? "[PUBLISH]" : "[DRY-RUN]"} ${filtered.length} packages`);
  if (flags.tag) console.log(`  tag: ${flags.tag}`);
  if (flags.filter) console.log(`  filter: ${flags.filter.join(", ")}`);

  let succeeded = 0;
  let failed = 0;
  for (const pkg of filtered) {
    const distDir = join(pkg.dir, "dist");
    const publishDir = existsSync(join(distDir, "package.json"))
      ? distDir
      : pkg.dir;
    if (flags.apply && isAlreadyPublished(pkg)) {
      console.warn(`  ${pkg.name}@${pkg.version}: SKIP (already published)`);
      continue;
    }
    const args = [flags.apply ? "publish" : "pack", "--dry-run"];
    if (flags.apply) args.splice(1, 1); // remove --dry-run for real publish
    if (flags.tag) args.push("--tag", flags.tag);
    if (flags.otp) args.push("--otp", flags.otp);
    args.push("--ignore-scripts");
    args.push("--access", "public");

    try {
      const target =
        publishDir === distDir ? `${pkg.dir}/dist` : pkg.dir;
      console.log(`  ${pkg.name}@${pkg.version}: ${args.join(" ")} (${target})`);
      execFileSync("npm", args, { cwd: publishDir, stdio: "inherit" });
      succeeded++;
    } catch (err) {
      failed++;
      console.error(`    FAILED: ${err.message}`);
    }
  }

  console.log(`\nDone. ${succeeded} succeeded, ${failed} failed.`);
  if (failed) process.exit(1);
}

function isAlreadyPublished(pkg) {
  try {
    execFileSync("npm", ["view", `${pkg.name}@${pkg.version}`, "version"], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

main();
