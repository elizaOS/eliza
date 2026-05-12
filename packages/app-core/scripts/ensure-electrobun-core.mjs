#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const TARGET_OS = new Set(["macos", "win", "linux"]);
const TARGET_ARCH = new Set(["arm64", "x64"]);

function fail(message, code = 1) {
  console.error(`[ensure-electrobun-core] ${message}`);
  process.exit(code);
}

function parseArgs(argv) {
  const options = {
    check: false,
    packageDir: null,
    target: null,
    workspace: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    const readValue = (name) => {
      const inlinePrefix = `--${name}=`;
      if (item.startsWith(inlinePrefix)) {
        return item.slice(inlinePrefix.length);
      }
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        fail(`Missing value for --${name}`);
      }
      index += 1;
      return value;
    };

    if (item === "--check") {
      options.check = true;
    } else if (item === "--workspace" || item.startsWith("--workspace=")) {
      options.workspace = readValue("workspace");
    } else if (item === "--package-dir" || item.startsWith("--package-dir=")) {
      options.packageDir = readValue("package-dir");
    } else if (item === "--target" || item.startsWith("--target=")) {
      options.target = readValue("target");
    } else if (item === "--help" || item === "-h") {
      printUsage();
      process.exit(0);
    } else {
      fail(`Unknown argument: ${item}`);
    }
  }

  return options;
}

function printUsage() {
  console.log(`Usage: node eliza/packages/app-core/scripts/ensure-electrobun-core.mjs [options]

Options:
  --workspace <dir>    Workspace whose package.json resolves electrobun (default: cwd)
  --package-dir <dir>  Installed electrobun package directory
  --target <target>    macos-arm64, macos-x64, win-x64, windows-x64, linux-x64, linux-arm64
  --check              Fail if core binaries are missing instead of downloading them
`);
}

function verifyElectrobunPackageDir(packageDir) {
  const manifestPath = path.join(packageDir, "package.json");
  if (!fs.existsSync(manifestPath)) {
    fail(`Electrobun package manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "electrobun") {
    fail(`Expected electrobun at ${manifestPath}, found ${manifest.name}`);
  }

  return { manifest, manifestPath };
}

export function resolveElectrobunPackageDir({
  packageDir = null,
  workspace = process.cwd(),
} = {}) {
  if (packageDir) {
    const resolved = path.resolve(packageDir);
    verifyElectrobunPackageDir(resolved);
    return resolved;
  }

  const workspacePackageJson = path.join(
    path.resolve(workspace),
    "package.json",
  );
  const req = createRequire(workspacePackageJson);
  let entryPath;
  try {
    entryPath = req.resolve("electrobun");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(
      `Could not resolve electrobun from ${workspacePackageJson}: ${detail}`,
    );
  }

  let current = path.dirname(entryPath);
  while (current !== path.dirname(current)) {
    const manifestPath = path.join(current, "package.json");
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (manifest.name === "electrobun") {
        return current;
      }
    }
    current = path.dirname(current);
  }

  fail(
    `Could not find electrobun package directory starting from ${entryPath}`,
  );
}

function normalizeOs(value) {
  if (value === "darwin") return "macos";
  if (value === "win32" || value === "windows") return "win";
  return value;
}

function normalizeArch(value) {
  if (value === "x86_64" || value === "amd64") return "x64";
  if (value === "aarch64") return "arm64";
  return value;
}

export function normalizeElectrobunCoreTarget(rawTarget = null) {
  if (!rawTarget) {
    const osName = normalizeOs(process.platform);
    const archName = normalizeArch(process.arch);
    return normalizeElectrobunCoreTarget(`${osName}-${archName}`);
  }

  const match = /^([a-z0-9]+)-([a-z0-9_]+)$/i.exec(rawTarget);
  if (!match) {
    throw new Error(`Invalid Electrobun core target: ${rawTarget}`);
  }

  const osName = normalizeOs(match[1]);
  const archName = normalizeArch(match[2]);
  if (!TARGET_OS.has(osName) || !TARGET_ARCH.has(archName)) {
    throw new Error(`Unsupported Electrobun core target: ${rawTarget}`);
  }

  return {
    id: `${osName}-${archName}`,
    os: osName,
    arch: archName,
  };
}

export function getRequiredElectrobunCoreRelativePaths(target) {
  const binExt = target.os === "win" ? ".exe" : "";
  const required = [`bun${binExt}`, `bsdiff${binExt}`, `bspatch${binExt}`];

  if (target.os === "macos") {
    required.push("launcher", "libNativeWrapper.dylib");
  } else if (target.os === "win") {
    required.push("libNativeWrapper.dll");
  } else {
    required.push("libNativeWrapper.so");
  }

  return required;
}

export function getElectrobunCoreDistDir(packageDir, target) {
  return path.join(packageDir, `dist-${target.id}`);
}

export function findMissingElectrobunCoreFiles(packageDir, target) {
  const distDir = getElectrobunCoreDistDir(packageDir, target);
  return getRequiredElectrobunCoreRelativePaths(target).filter(
    (relativePath) => !fs.existsSync(path.join(distDir, relativePath)),
  );
}

export function getElectrobunCoreTarballUrl(version, target) {
  const platformName =
    target.os === "macos" ? "darwin" : target.os === "win" ? "win" : "linux";
  return `https://github.com/blackboardsh/electrobun/releases/download/v${version}/electrobun-core-${platformName}-${target.arch}.tar.gz`;
}

async function downloadFile(url, targetPath) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(targetPath),
  );
}

function getTarExecutable() {
  if (process.platform === "win32") {
    const windowsTar = "C:\\Windows\\System32\\tar.exe";
    if (fs.existsSync(windowsTar)) return windowsTar;
  }
  return "tar";
}

function extractTarball(tarballPath, distDir) {
  fs.mkdirSync(distDir, { recursive: true });
  const result = spawnSync(
    getTarExecutable(),
    ["-xzf", tarballPath, "-C", distDir],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`tar failed with exit code ${result.status ?? 1}`);
  }
}

export async function ensureElectrobunCore({
  packageDir,
  target,
  check = false,
} = {}) {
  const { manifest } = verifyElectrobunPackageDir(packageDir);
  const distDir = getElectrobunCoreDistDir(packageDir, target);
  let missing = findMissingElectrobunCoreFiles(packageDir, target);

  if (missing.length === 0) {
    console.log(
      `[ensure-electrobun-core] Electrobun core binaries ready for ${target.id}: ${distDir}`,
    );
    return;
  }

  if (check) {
    fail(
      `Electrobun core binaries missing for ${target.id}: ${missing.join(", ")}`,
    );
  }

  const cacheDir = path.join(packageDir, ".cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  const url = getElectrobunCoreTarballUrl(manifest.version, target);
  const tarballName = `electrobun-core-${target.id}-v${manifest.version}.tar.gz`;
  const tarballPath = path.join(cacheDir, tarballName);

  if (!fs.existsSync(tarballPath) || fs.statSync(tarballPath).size === 0) {
    console.log(
      `[ensure-electrobun-core] Preparing Electrobun core binaries for ${target.id}`,
    );
    console.log(`[ensure-electrobun-core] Downloading ${url}`);
    await downloadFile(url, tarballPath);
  } else {
    console.log(
      `[ensure-electrobun-core] Reusing cached Electrobun core tarball for ${target.id}: ${tarballPath}`,
    );
  }

  console.log(`[ensure-electrobun-core] Extracting ${target.id} core binaries`);
  extractTarball(tarballPath, distDir);

  missing = findMissingElectrobunCoreFiles(packageDir, target);
  if (missing.length > 0) {
    fail(
      `Electrobun core extraction incomplete for ${target.id}; still missing: ${missing.join(", ")}`,
    );
  }

  console.log(
    `[ensure-electrobun-core] Electrobun core binaries ready for ${target.id}: ${distDir}`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let target;
  try {
    target = normalizeElectrobunCoreTarget(options.target);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const packageDir = resolveElectrobunPackageDir({
    packageDir: options.packageDir,
    workspace: options.workspace,
  });

  await ensureElectrobunCore({
    packageDir,
    target,
    check: options.check,
  });
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return (
    fs.realpathSync(fileURLToPath(import.meta.url)) ===
    fs.realpathSync(path.resolve(process.argv[1]))
  );
}

if (isMainModule()) {
  main().catch((error) => {
    fail(error instanceof Error ? error.message : String(error));
  });
}
