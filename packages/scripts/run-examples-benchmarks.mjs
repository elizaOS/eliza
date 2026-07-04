#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { listPackages } from "./lib/workspaces.mjs";

const scriptName = process.argv[2];
if (!scriptName) {
  console.error(
    "Usage: node packages/scripts/run-examples-benchmarks.mjs <script> [--list[=text|json]]",
  );
  process.exit(1);
}
const listArg = process.argv
  .slice(3)
  .find((arg) => arg === "--list" || arg.startsWith("--list="));
const listFormat = listArg?.includes("=") ? listArg.split("=", 2)[1] : "text";

if (listArg && !["text", "json"].includes(listFormat)) {
  console.error(
    `[${scriptName}] unsupported --list format "${listFormat}" (expected text or json)`,
  );
  process.exit(1);
}

const root = process.cwd();
const roots = ["packages/examples", "packages/benchmarks"];

// Only run the target script for real workspace members under these roots.
// Self-contained sub-projects here (own lockfile + toolchain, e.g. the
// standalone `@solana-gauntlet/sdk` with its external `@solana/web3.js` dep)
// are excluded by the root `workspaces` globs — their deps are never installed
// by the monorepo, so a `tsc` sweep would fail with TS2307. They build
// standalone; turbo already builds every real member. Discovery is the shared
// seam (honors `workspaces` negation); the caller keeps its examples/benchmarks
// scope and "has this script" filter.
const isUnderRoots = (dir) =>
  roots.some((entry) => dir === entry || dir.startsWith(`${entry}/`));

const packages = listPackages({ repoRoot: root })
  .filter((pkg) => isUnderRoots(pkg.dir))
  .map((pkg) => ({
    dir: pkg.dir,
    name: pkg.packageJson.name ?? pkg.dir,
    scripts: pkg.packageJson.scripts ?? {},
  }))
  .filter((pkg) => Object.hasOwn(pkg.scripts, scriptName));

if (listArg) {
  if (listFormat === "json") {
    process.stdout.write(
      `${JSON.stringify(
        {
          script: scriptName,
          roots,
          packages: packages.map(({ name, dir }) => ({ name, dir })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const pkg of packages) {
      console.log(`${pkg.name}\t${pkg.dir}`);
    }
  }
  process.exit(0);
}

let failed = false;
for (const pkg of packages) {
  const relativeDir = pkg.dir;
  console.log(`\n[${scriptName}] ${pkg.name} (${relativeDir})`);
  const result = spawnSync("bun", ["run", scriptName], {
    cwd: path.join(root, pkg.dir),
    env: process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failed = true;
    console.error(
      `[${scriptName}] failed in ${relativeDir} with exit code ${result.status}`,
    );
    break;
  }
}

process.exit(failed ? 1 : 0);
