#!/usr/bin/env node

/**
 * scripts/pack-upstreams.mjs
 * Packs upstream packages from vendored checkout to test without workspace links.
 */

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");
const ELIZA_ROOT = existsSync(
  path.join(ROOT, "packages", "core", "package.json"),
)
  ? ROOT
  : path.join(ROOT, "eliza");

// Seed packages to pack. Their local workspace dependencies are added
// automatically so PR tarball install tests do not depend on already-published
// beta packages.
const SEED_TARGETS = [
  { label: "@elizaos/core", dir: path.join(ELIZA_ROOT, "packages", "core") },
  {
    label: "@elizaos/shared",
    dir: path.join(ELIZA_ROOT, "packages", "shared"),
  },
  { label: "@elizaos/ui", dir: path.join(ELIZA_ROOT, "packages", "ui") },
  {
    label: "@elizaos/vault",
    dir: path.join(ELIZA_ROOT, "packages", "vault"),
  },
  {
    label: "@elizaos/cloud-routing",
    dir: path.join(ELIZA_ROOT, "packages", "cloud-routing"),
  },
  {
    label: "@elizaos/skills",
    dir: path.join(ELIZA_ROOT, "packages", "skills"),
  },
  {
    label: "@elizaos/app-core",
    dir: path.join(ELIZA_ROOT, "packages", "app-core"),
  },
  {
    label: "@elizaos/agent",
    dir: path.join(ELIZA_ROOT, "packages", "agent"),
  },
  {
    label: "@elizaos/plugin-sql",
    dir: path.join(ELIZA_ROOT, "plugins", "plugin-sql"),
  },
];

function runCommand(command, args, cwd) {
  const printable = `${command} ${args.join(" ")}`;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", (error) =>
      reject(new Error(`${printable} failed: ${error.message}`)),
    );
    child.on("exit", (code, signal) => {
      if (signal)
        return reject(new Error(`${printable} exited due to signal ${signal}`));
      if (code !== 0)
        return reject(new Error(`${printable} exited with code ${code}`));
      resolve();
    });
  });
}

function readPackageJson(dir) {
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function collectWorkspacePackages(root) {
  const packageRoots = [
    path.join(root, "packages"),
    path.join(root, "plugins"),
    path.join(root, "cloud", "packages"),
  ];
  const packages = new Map();

  for (const packageRoot of packageRoots) {
    walk(packageRoot, (entryPath) => {
      if (path.basename(entryPath) !== "package.json") {
        return;
      }
      const pkgJson = readPackageJson(path.dirname(entryPath));
      if (
        !pkgJson ||
        pkgJson.private === true ||
        typeof pkgJson.name !== "string" ||
        typeof pkgJson.version !== "string"
      ) {
        return;
      }
      if (!packages.has(pkgJson.name)) {
        packages.set(pkgJson.name, {
          label: pkgJson.name,
          dir: path.dirname(entryPath),
        });
      }
    });
  }

  for (const target of SEED_TARGETS) {
    packages.set(target.label, target);
  }

  return packages;
}

function walk(dirPath, visit) {
  let entries;
  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      if (
        [
          "node_modules",
          "dist",
          ".git",
          ".turbo",
          "android",
          "ios",
          "build",
        ].includes(entry.name)
      ) {
        continue;
      }
      walk(entryPath, visit);
      continue;
    }
    visit(entryPath);
  }
}

function collectLocalDependencyNames(pkgJson, workspacePackages) {
  const names = new Set();
  for (const sectionName of ["dependencies", "optionalDependencies"]) {
    const section = pkgJson[sectionName];
    if (!section || typeof section !== "object") {
      continue;
    }
    for (const [name, spec] of Object.entries(section)) {
      if (
        typeof spec === "string" &&
        spec.startsWith("workspace:") &&
        workspacePackages.has(name)
      ) {
        names.add(name);
      }
    }
  }
  return names;
}

function resolveTargets() {
  const workspacePackages = collectWorkspacePackages(ELIZA_ROOT);
  const targets = new Map();
  const queue = SEED_TARGETS.map((target) => target.label);

  for (let index = 0; index < queue.length; index += 1) {
    const label = queue[index];
    if (targets.has(label)) {
      continue;
    }

    const target = workspacePackages.get(label);
    if (!target) {
      throw new Error(
        `[pack-upstreams] Missing local workspace package ${label}`,
      );
    }

    const pkgJson = readPackageJson(target.dir);
    if (!pkgJson) {
      throw new Error(
        `[pack-upstreams] No package.json found in ${target.dir}`,
      );
    }

    targets.set(label, target);
    for (const dependencyName of collectLocalDependencyNames(
      pkgJson,
      workspacePackages,
    )) {
      if (!targets.has(dependencyName)) {
        queue.push(dependencyName);
      }
    }
  }

  return {
    targets: [...targets.values()],
    workspacePackages,
  };
}

function workspaceSpecToVersion(spec, version) {
  if (spec === "workspace:^") {
    return `^${version}`;
  }
  if (spec === "workspace:~") {
    return `~${version}`;
  }
  return version;
}

function rewriteWorkspaceDependencies(packDir, pkgJson, workspacePackages) {
  let changed = false;
  const nextPkgJson = structuredClone(pkgJson);
  for (const sectionName of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const section = nextPkgJson[sectionName];
    if (!section || typeof section !== "object") {
      continue;
    }
    for (const [name, spec] of Object.entries(section)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) {
        continue;
      }
      const workspacePackage = workspacePackages.get(name);
      if (!workspacePackage) {
        throw new Error(
          `[pack-upstreams] ${pkgJson.name} depends on unknown workspace package ${name}`,
        );
      }
      const dependencyPkgJson = readPackageJson(workspacePackage.dir);
      if (!dependencyPkgJson?.version) {
        throw new Error(
          `[pack-upstreams] Could not resolve version for workspace package ${name}`,
        );
      }
      section[name] = workspaceSpecToVersion(spec, dependencyPkgJson.version);
      changed = true;
    }
  }

  if (!changed) {
    return null;
  }

  const packageJsonPath = path.join(packDir, "package.json");
  const originalPackageJson = readFileSync(packageJsonPath, "utf8");
  writeFileSync(packageJsonPath, `${JSON.stringify(nextPkgJson, null, 2)}\n`);
  return () => writeFileSync(packageJsonPath, originalPackageJson);
}

function packageTarballName(pkgJson) {
  return `${pkgJson.name.replace(/^@/, "").replace("/", "-")}-${pkgJson.version}.tgz`;
}

function resolvePackDir(pkgDir, pkgJson) {
  const directory = pkgJson.publishConfig?.directory;
  return typeof directory === "string" && directory.trim()
    ? path.join(pkgDir, directory)
    : pkgDir;
}

async function packUpstreams() {
  if (!existsSync(path.join(ELIZA_ROOT, "package.json"))) {
    throw new Error(
      `Could not find eliza workspace at ${ELIZA_ROOT}. Run this from a standalone eliza checkout or a Milady checkout with eliza/ present.`,
    );
  }

  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  const { targets, workspacePackages } = resolveTargets();
  console.log(
    `[pack-upstreams] Packing ${targets.length} package(s): ${targets
      .map((target) => target.label)
      .join(", ")}`,
  );

  for (const target of targets) {
    const pkgDir = target.dir;
    if (!existsSync(pkgDir)) {
      throw new Error(
        `[pack-upstreams] Missing required ${target.label} directory: ${pkgDir}`,
      );
    }

    const pkgJson = readPackageJson(pkgDir);
    if (!pkgJson) {
      throw new Error(`[pack-upstreams] No package.json found in ${pkgDir}`);
    }
    if (pkgJson.name !== target.label) {
      throw new Error(
        `[pack-upstreams] Expected ${target.label} at ${pkgDir}, found ${pkgJson.name ?? "unknown"}`,
      );
    }

    console.log(`\n[pack-upstreams] === Packing ${pkgJson.name} ===`);
    const sourceTarballPath = path.join(
      ARTIFACTS_DIR,
      packageTarballName(pkgJson),
    );
    if (
      process.env.PACK_UPSTREAMS_FORCE !== "1" &&
      existsSync(sourceTarballPath)
    ) {
      console.log(
        `[pack-upstreams] Reusing existing tarball at ${sourceTarballPath}`,
      );
      continue;
    }

    if (pkgJson.scripts?.build) {
      console.log(`[pack-upstreams] Building ${pkgJson.name}...`);
      await runCommand("bun", ["run", "build"], pkgDir);
    }

    const packDir = resolvePackDir(pkgDir, pkgJson);
    const packPkgJson = readPackageJson(packDir);
    if (!packPkgJson) {
      throw new Error(
        `[pack-upstreams] No package.json found in pack directory ${packDir}`,
      );
    }
    const expectedTarballName = packageTarballName(packPkgJson);
    const destTarballPath = path.join(ARTIFACTS_DIR, expectedTarballName);

    // We use npm pack as it handles prepack correctly and is standard.
    // Bun pm pack also works but npm pack is generally more tested for tarball generation.
    console.log(
      `[pack-upstreams] Packing ${packPkgJson.name} from ${packDir}...`,
    );
    const restorePackageJson = rewriteWorkspaceDependencies(
      packDir,
      packPkgJson,
      workspacePackages,
    );
    try {
      await runCommand(
        "npm",
        ["pack", "--pack-destination", ARTIFACTS_DIR],
        packDir,
      );
    } finally {
      restorePackageJson?.();
    }

    if (!existsSync(destTarballPath)) {
      throw new Error(
        `[pack-upstreams] Tarball not found at expected path after pack: ${destTarballPath}`,
      );
    }
    console.log(`[pack-upstreams] Packed tarball at ${destTarballPath}`);
  }

  console.log("\n[pack-upstreams] Done packing all targets.");
}

packUpstreams().catch((error) => {
  console.error(`\n[pack-upstreams] Error: ${error.message}`);
  process.exit(1);
});
