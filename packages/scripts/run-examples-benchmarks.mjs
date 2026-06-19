#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const scriptName = process.argv[2];
if (!scriptName) {
  console.error(
    "Usage: node packages/scripts/run-examples-benchmarks.mjs <script>",
  );
  process.exit(1);
}

const root = process.cwd();
const roots = ["packages/examples", "packages/benchmarks"];
const ignoredDirs = new Set([
  ".git",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "dist",
  "node_modules",
]);

// Only build packages that the root `bun install` provisions, i.e. packages
// matched by the root `workspaces` globs. Self-contained sub-projects under
// these roots (own lockfile + toolchain, e.g. the standalone
// `@solana-gauntlet/sdk` with its external `@solana/web3.js` dep) are not
// workspace members, so their dependencies are never installed by the
// monorepo and `tsc` fails with TS2307 in CI. They are meant to be built
// standalone, not swept here. turbo already builds every real member.
const workspaceGlobs = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).workspaces;

function workspaceGlobToRegExp(glob) {
  let pattern = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        pattern += ".*";
        i += 1;
      } else {
        pattern += "[^/]*";
      }
    } else if (/[.+^${}()|[\]\\]/.test(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

const workspaceMatchers = workspaceGlobs.map((glob) => {
  const negated = glob.startsWith("!");
  return {
    negated,
    regExp: workspaceGlobToRegExp(negated ? glob.slice(1) : glob),
  };
});

function isWorkspaceMember(packageDir) {
  const relative = path.relative(root, packageDir);
  let member = false;
  for (const { negated, regExp } of workspaceMatchers) {
    if (regExp.test(relative)) {
      member = !negated;
    }
  }
  return member;
}

function collectPackageJsons(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (ignoredDirs.has(name)) continue;
    const fullPath = path.join(dir, name);
    let stat;
    try {
      stat = lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      collectPackageJsons(fullPath, out);
      continue;
    }
    if (name === "package.json") {
      out.push(fullPath);
    }
  }
  return out;
}

const packages = roots
  .flatMap((entry) => collectPackageJsons(path.join(root, entry)))
  .sort()
  .map((packageJsonPath) => {
    const packageDir = path.dirname(packageJsonPath);
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return {
      dir: packageDir,
      name: manifest.name ?? path.relative(root, packageDir),
      scripts: manifest.scripts ?? {},
    };
  })
  .filter((pkg) => Object.hasOwn(pkg.scripts, scriptName))
  .filter((pkg) => isWorkspaceMember(pkg.dir));

let failed = false;
for (const pkg of packages) {
  const relativeDir = path.relative(root, pkg.dir);
  console.log(`\n[${scriptName}] ${pkg.name} (${relativeDir})`);
  const result = spawnSync("bun", ["run", scriptName], {
    cwd: pkg.dir,
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
