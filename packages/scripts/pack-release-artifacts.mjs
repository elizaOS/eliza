#!/usr/bin/env node

/**
 * Emit real npm tarballs (`.tgz`) for every public, dist-declaring workspace
 * package into a release-artifacts directory, plus a SHA256SUMS-npm.txt.
 *
 * These are the exact tarballs `npm publish` would upload — attaching them to
 * the GitHub release gives users offline / air-gapped installs and a
 * checksum-verifiable copy of what shipped to the registry.
 *
 * Discovery mirrors verify-npm-pack-dist.mjs (lerna globs -> git-tracked ->
 * non-private -> declares a dist entry point) so the emitted set matches the
 * published set. Run AFTER workspace:* references have been replaced with real
 * versions, so the packed dependency ranges match the registry.
 *
 * By default only the headline distributables are packed (the CLI + runtime
 * packages users actually download directly) to keep the release asset list
 * readable — every other package installs from the registry. Pass --all to
 * emit a tarball for every public dist package, or --packages a,b,c to pick.
 *
 * Usage:
 *   node packages/scripts/pack-release-artifacts.mjs --out <dir>
 *   node packages/scripts/pack-release-artifacts.mjs --out <dir> --all
 *   node packages/scripts/pack-release-artifacts.mjs --out <dir> --packages elizaos,@elizaos/core
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(scriptDir));

// Headline packages a user is likely to download directly rather than install
// from the registry. Everything else is available via `bun add`/`npm i`.
const HEADLINE_PACKAGES = [
  "elizaos",
  "@elizaos/core",
  "@elizaos/agent",
  "@elizaos/app-core",
];

const args = process.argv.slice(2);
let outDir = join(repoRoot, "release-artifacts", "npm");
let packAll = false;
let explicitPackages = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") {
    outDir = resolve(args[++i] ?? outDir);
  } else if (args[i] === "--all") {
    packAll = true;
  } else if (args[i] === "--packages") {
    explicitPackages = new Set(
      (args[++i] ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } else {
    console.error(`Unknown argument: ${args[i]}`);
    process.exit(1);
  }
}

function normalizePackagePath(value) {
  return value.replace(/^\.\//, "").replace(/\\/g, "/");
}

function isDistArtifactPath(value) {
  const normalized = normalizePackagePath(value);
  return normalized.startsWith("dist/") || normalized.includes("/dist/");
}

function collectDistReferences(value, references = new Set()) {
  if (typeof value === "string") {
    const normalized = normalizePackagePath(value);
    if (isDistArtifactPath(normalized) && !normalized.includes("*")) {
      references.add(normalized);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) collectDistReferences(item, references);
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectDistReferences(item, references);
    }
  }
  return references;
}

function expectsDist(pkg) {
  return (
    collectDistReferences({
      main: pkg.main,
      module: pkg.module,
      types: pkg.types,
      bin: pkg.bin,
      exports: pkg.exports,
    }).size > 0
  );
}

function expandLernaPackagePattern(pattern) {
  if (!pattern.includes("*")) return [pattern];
  const [baseDir, suffix = ""] = pattern.split("*");
  const normalizedBase = baseDir.replace(/\/$/, "");
  const absoluteBase = join(repoRoot, normalizedBase);
  if (!existsSync(absoluteBase)) return [];
  return readdirSync(absoluteBase, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      join(normalizedBase, entry.name, suffix.replace(/^\//, "")).replace(
        /\\/g,
        "/",
      ),
    );
}

function isTrackedPackageManifest(packageJsonPath) {
  try {
    execFileSync(
      "git",
      ["ls-files", "--error-unmatch", relative(repoRoot, packageJsonPath)],
      { cwd: repoRoot, stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function discoverPublicDistPackageDirs() {
  const lerna = JSON.parse(readFileSync(join(repoRoot, "lerna.json"), "utf8"));
  const dirs = new Set();
  for (const pattern of lerna.packages ?? []) {
    for (const packageDir of expandLernaPackagePattern(pattern)) {
      const packageJsonPath = join(repoRoot, packageDir, "package.json");
      if (!existsSync(packageJsonPath)) continue;
      if (!isTrackedPackageManifest(packageJsonPath)) continue;
      const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      if (pkg.private === true) continue;
      if (!expectsDist(pkg)) continue;
      dirs.add(packageDir);
    }
  }
  return [...dirs].sort();
}

function npmInvocation(extraArgs) {
  if (process.platform === "win32") {
    const npmCliPath = join(
      dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    );
    if (existsSync(npmCliPath)) {
      return { command: process.execPath, args: [npmCliPath, ...extraArgs] };
    }
  }
  return { command: "npm", args: extraArgs };
}

function parsePackJson(output) {
  const trimmed = output.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\[\s*\{[\s\S]*\]\s*$/);
    if (!match) throw new Error(`Unable to parse npm pack JSON:\n${trimmed}`);
    return JSON.parse(match[0]);
  }
}

mkdirSync(outDir, { recursive: true });

const allPackageDirs = discoverPublicDistPackageDirs();
if (allPackageDirs.length === 0) {
  console.error(
    "No public dist packages discovered — refusing to emit an empty artifact set.",
  );
  process.exit(1);
}

function packageName(packageDir) {
  return JSON.parse(
    readFileSync(join(repoRoot, packageDir, "package.json"), "utf8"),
  ).name;
}

let packageDirs;
if (packAll) {
  packageDirs = allPackageDirs;
} else {
  const wanted = explicitPackages ?? new Set(HEADLINE_PACKAGES);
  const byName = new Map(allPackageDirs.map((d) => [packageName(d), d]));
  packageDirs = [...wanted].map((name) => {
    const dir = byName.get(name);
    if (!dir) {
      console.error(
        `Requested package '${name}' is not a public dist package — aborting so the release does not silently drop it.`,
      );
      process.exit(1);
    }
    return dir;
  });
}

console.log(
  `Packing ${packageDirs.length}/${allPackageDirs.length} public package(s) into ${outDir}`,
);

const checksums = [];
for (const packageDir of packageDirs) {
  const absoluteDir = join(repoRoot, packageDir);
  const pkg = JSON.parse(
    readFileSync(join(absoluteDir, "package.json"), "utf8"),
  );
  const npm = npmInvocation(["pack", "--json", "--pack-destination", outDir]);
  const output = execFileSync(npm.command, npm.args, {
    cwd: absoluteDir,
    encoding: "utf8",
    env: { ...process.env, npm_config_loglevel: "error" },
  });
  const filename = parsePackJson(output)[0]?.filename;
  if (!filename) {
    throw new Error(`npm pack did not report a filename for ${pkg.name}`);
  }
  const tarballPath = join(outDir, filename);
  if (!existsSync(tarballPath)) {
    throw new Error(`Expected tarball not found: ${tarballPath}`);
  }
  const digest = createHash("sha256")
    .update(readFileSync(tarballPath))
    .digest("hex");
  checksums.push(`${digest}  ${filename}`);
  console.log(`  ✅ ${filename}`);
}

writeFileSync(join(outDir, "SHA256SUMS-npm.txt"), `${checksums.join("\n")}\n`);
console.log(
  `\n✅ ${checksums.length} tarball(s) + SHA256SUMS-npm.txt written to ${outDir}`,
);
