#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveMainAppDir } from "./lib/app-dir.mjs";

function fail(message, code = 1) {
  console.error(`[build-patched-electrobun-cli] ${message}`);
  process.exit(code);
}

function run(command, args, options = {}) {
  const rendered = [command, ...args].join(" ");
  console.log(`[build-patched-electrobun-cli] ${rendered}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.status !== 0) {
    fail(`${rendered} failed with exit code ${result.status ?? 1}`);
  }
}

function runAllowFailure(command, args, options = {}) {
  const rendered = [command, ...args].join(" ");
  console.log(`[build-patched-electrobun-cli] ${rendered}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });
  if (result.signal) {
    fail(`${rendered} failed with signal ${result.signal}`);
  }
  return result.status ?? 1;
}

function resolveElectrobunDir() {
  const appDir = resolveMainAppDir(process.cwd(), "app");
  const workspacePackageJson = path.join(appDir, "package.json");
  const req = createRequire(workspacePackageJson);
  const entryPath = req.resolve("electrobun");
  let packageDir = path.dirname(entryPath);

  while (!existsSync(path.join(packageDir, "package.json"))) {
    const parentDir = path.dirname(packageDir);
    if (parentDir === packageDir) {
      fail(`Could not find electrobun package.json starting from ${entryPath}`);
    }
    packageDir = parentDir;
  }

  const manifestPath = path.join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "electrobun") {
    fail(`Resolved unexpected package at ${manifestPath}: ${manifest.name}`);
  }

  return packageDir;
}

function writeGitHubEnv(name, value) {
  if (!process.env.GITHUB_ENV) {
    return;
  }
  appendFileSync(process.env.GITHUB_ENV, `${name}=${value}\n`);
}

function insertAfterAnchor(source, anchor, insertion, label) {
  const anchorIndex = source.indexOf(anchor);
  if (anchorIndex === -1) {
    throw new Error(`Could not find ${label} anchor: ${anchor}`);
  }

  const insertAt = anchorIndex + anchor.length;
  return `${source.slice(0, insertAt)}${insertion}${source.slice(insertAt)}`;
}

export function patchCliSourceText(original) {
  if (
    original.includes(
      'const overridePackageJson = process.env["ELECTROBUN_RCEDIT_PACKAGE_JSON"];',
    )
  ) {
    return original;
  }

  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  let patched = original;
  const importAnchor = 'import * as readline from "readline";';

  if (!patched.includes('import { createRequire } from "module";')) {
    patched = patched.replace(
      importAnchor,
      [
        importAnchor,
        'import { createRequire } from "module";',
        'import { pathToFileURL } from "url";',
      ].join(eol),
    );
  }

  if (!patched.includes("async function importRcedit()")) {
    patched = insertAfterAnchor(
      patched,
      "const _MAX_CHUNK_SIZE = 1024 * 2;",
      [
        "",
        "",
        "async function importRcedit() {",
        '  const overridePackageJson = process.env["ELECTROBUN_RCEDIT_PACKAGE_JSON"];',
        "  if (overridePackageJson) {",
        "    const overrideRequire = createRequire(overridePackageJson);",
        '    const overrideEntry = overrideRequire.resolve("rcedit");',
        "    const overrideModule = await import(pathToFileURL(overrideEntry).href);",
        "    return overrideModule.default ?? overrideModule;",
        "  }",
        "",
        '  const rceditModule = await import("rcedit");',
        "  return rceditModule.default ?? rceditModule;",
        "}",
        "",
      ].join(eol),
      "_MAX_CHUNK_SIZE",
    );
  }

  const replacements = patched.match(
    /const rcedit = \(await import\("rcedit"\)\)\.default;/g,
  );
  if (!replacements || replacements.length !== 3) {
    throw new Error(
      `Expected 3 rcedit dynamic import call sites, found ${replacements?.length ?? 0}`,
    );
  }

  patched = patched.replaceAll(
    'const rcedit = (await import("rcedit")).default;',
    "const rcedit = await importRcedit();",
  );

  if (!patched.includes("async function importRcedit()")) {
    throw new Error("importRcedit helper was not inserted");
  }

  return patched;
}

function patchCliSource(cliIndexPath) {
  const original = readFileSync(cliIndexPath, "utf8");
  let patched;
  try {
    patched = patchCliSourceText(original);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Failed to patch ${cliIndexPath}: ${message}`);
  }

  writeFileSync(cliIndexPath, patched, "utf8");
}

function writeEmbeddedTemplatesStub(embeddedTemplatesPath) {
  mkdirSync(path.dirname(embeddedTemplatesPath), { recursive: true });
  writeFileSync(
    embeddedTemplatesPath,
    `export function getTemplateNames() {
  return [];
}

export function getTemplate() {
  return null;
}
`,
    "utf8",
  );
}

function resolveBuildTarget(value) {
  const normalized =
    value ||
    (process.platform === "win32"
      ? "windows-x64"
      : process.platform === "darwin"
        ? `macos-${process.arch === "arm64" ? "arm64" : "x64"}`
        : `linux-${process.arch === "arm64" ? "arm64" : "x64"}`);

  switch (normalized) {
    case "windows-x64":
    case "win-x64":
      return {
        artifactName: "windows-x64",
        bunTarget: "bun-windows-x64-baseline",
        fallbackBunTarget: "bun-windows-x64",
        executableName: "electrobun.exe",
      };
    case "macos-arm64":
      return {
        artifactName: normalized,
        bunTarget: "bun-darwin-arm64",
        executableName: "electrobun",
      };
    case "macos-x64":
      return {
        artifactName: normalized,
        bunTarget: "bun-darwin-x64",
        executableName: "electrobun",
      };
    case "linux-arm64":
      return {
        artifactName: normalized,
        bunTarget: "bun-linux-arm64",
        executableName: "electrobun",
      };
    case "linux-x64":
      return {
        artifactName: normalized,
        bunTarget: "bun-linux-x64",
        executableName: "electrobun",
      };
    default:
      fail(`Unsupported Electrobun CLI build target: ${normalized}`);
  }
}

function resolveTargetPaths(
  upstreamPackageDir,
  installedElectrobunDir,
  target,
) {
  return {
    BUILD_BINARY: path.join(
      upstreamPackageDir,
      "src",
      "cli",
      "build",
      target.executableName,
    ),
    BUN_BINARY: path.join(installedElectrobunDir, "bin", target.executableName),
    CACHE_BINARY: path.join(
      installedElectrobunDir,
      ".cache",
      target.executableName,
    ),
  };
}

function buildPatchedCli(upstreamPackageDir, buildTarget, targetPaths, env) {
  console.log(
    `[electrobun-build] Bun entry: ${path.join(upstreamPackageDir, "src", "cli", "index.ts")}`,
  );
  console.log(
    `[electrobun-build] Target ${buildTarget.artifactName}: ${buildTarget.bunTarget}`,
  );

  mkdirSync(path.dirname(targetPaths.BUILD_BINARY), { recursive: true });
  const buildArgs = [
    "build",
    "src/cli/index.ts",
    "--compile",
    `--target=${buildTarget.bunTarget}`,
    "--outfile",
    targetPaths.BUILD_BINARY,
  ];
  const status = runAllowFailure("bun", buildArgs, {
    cwd: upstreamPackageDir,
    env,
  });

  if (status !== 0) {
    if (!buildTarget.fallbackBunTarget) {
      fail(`bun build failed with exit code ${status}`);
    }

    console.warn(
      `[build-patched-electrobun-cli] Bun CLI build failed for ${buildTarget.bunTarget}; retrying with ${buildTarget.fallbackBunTarget}.`,
    );
    const fallbackStatus = runAllowFailure(
      "bun",
      buildArgs.map((arg) =>
        arg === `--target=${buildTarget.bunTarget}`
          ? `--target=${buildTarget.fallbackBunTarget}`
          : arg,
      ),
      {
        cwd: upstreamPackageDir,
        env,
      },
    );
    if (fallbackStatus !== 0) {
      fail(`bun fallback build failed with exit code ${fallbackStatus}`);
    }
    console.log("[build-patched-electrobun-cli] Bun CLI fallback succeeded");
  }

  if (!existsSync(targetPaths.BUILD_BINARY)) {
    fail(`Expected compiled CLI at ${targetPaths.BUILD_BINARY}`);
  }
}

function main() {
  const installedElectrobunDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : resolveElectrobunDir();
  const buildTarget = resolveBuildTarget(process.argv[3]);
  const installedManifestPath = path.join(
    installedElectrobunDir,
    "package.json",
  );
  const installedManifest = JSON.parse(
    readFileSync(installedManifestPath, "utf8"),
  );
  const electrobunVersion = installedManifest.version;
  const installedElectrobunRequire = createRequire(installedManifestPath);
  const resolvedRceditPackageJson = installedElectrobunRequire.resolve(
    "rcedit/package.json",
  );

  writeGitHubEnv("ELECTROBUN_RCEDIT_PACKAGE_JSON", resolvedRceditPackageJson);
  console.log(
    `[build-patched-electrobun-cli] Using rcedit package ${resolvedRceditPackageJson}`,
  );

  const tempRoot = path.join(
    process.env.RUNNER_TEMP ?? os.tmpdir(),
    `eliza-electrobun-src-${electrobunVersion}`,
  );
  rmSync(tempRoot, { recursive: true, force: true });

  run("git", [
    "clone",
    "--depth",
    "1",
    "--branch",
    `v${electrobunVersion}`,
    "--filter=blob:none",
    "--sparse",
    "https://github.com/blackboardsh/electrobun.git",
    tempRoot,
  ]);
  run("git", ["-C", tempRoot, "sparse-checkout", "set", "package"]);

  const upstreamPackageDir = path.join(tempRoot, "package");
  const cliIndexPath = path.join(upstreamPackageDir, "src", "cli", "index.ts");
  const embeddedTemplatesPath = path.join(
    upstreamPackageDir,
    "src",
    "cli",
    "templates",
    "embedded.ts",
  );

  writeEmbeddedTemplatesStub(embeddedTemplatesPath);
  patchCliSource(cliIndexPath);

  run("bun", ["install"], {
    cwd: upstreamPackageDir,
    env: {
      ...process.env,
      BUN_INSTALL_CACHE_DIR: path.join(tempRoot, ".bun-install-cache"),
    },
  });

  const buildEnv = {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: path.join(tempRoot, ".bun-install-cache"),
  };
  const targetPaths = resolveTargetPaths(
    upstreamPackageDir,
    installedElectrobunDir,
    buildTarget,
  );
  buildPatchedCli(upstreamPackageDir, buildTarget, targetPaths, buildEnv);

  const targetBinPath = targetPaths.BUN_BINARY;
  const targetCachePath = targetPaths.CACHE_BINARY;
  const installedBinPath = path.join(
    installedElectrobunDir,
    "bin",
    buildTarget.executableName,
  );
  const installedCachePath = path.join(
    installedElectrobunDir,
    ".cache",
    buildTarget.executableName,
  );
  if (
    installedBinPath !== targetBinPath ||
    installedCachePath !== targetCachePath
  ) {
    fail("Resolved Electrobun install paths are inconsistent.");
  }

  mkdirSync(path.dirname(installedBinPath), { recursive: true });
  mkdirSync(path.dirname(installedCachePath), { recursive: true });
  copyFileSync(targetPaths.BUILD_BINARY, installedBinPath);
  copyFileSync(targetPaths.BUILD_BINARY, installedCachePath);
  if (!buildTarget.executableName.endsWith(".exe")) {
    chmodSync(installedBinPath, 0o755);
    chmodSync(installedCachePath, 0o755);
  }

  console.log(
    `[build-patched-electrobun-cli] Installed patched CLI to ${installedBinPath}`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main();
}
