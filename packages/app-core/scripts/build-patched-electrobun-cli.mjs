#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
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

function resolveElectrobunDir() {
  const workspacePackageJson = path.resolve("apps/app/electrobun/package.json");
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

function main() {
  const installedElectrobunDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : resolveElectrobunDir();
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

  run(
    "bun",
    [
      "build",
      "src/cli/index.ts",
      "--compile",
      "--target=bun-windows-x64-baseline",
      "--outfile",
      "src/cli/build/electrobun",
    ],
    {
      cwd: upstreamPackageDir,
      env: {
        ...process.env,
        BUN_INSTALL_CACHE_DIR: path.join(tempRoot, ".bun-install-cache"),
      },
    },
  );

  const compiledCliPath = path.join(
    upstreamPackageDir,
    "src",
    "cli",
    "build",
    "electrobun.exe",
  );
  if (!existsSync(compiledCliPath)) {
    fail(`Expected compiled CLI at ${compiledCliPath}`);
  }

  const installedBinPath = path.join(
    installedElectrobunDir,
    "bin",
    "electrobun.exe",
  );
  const installedCachePath = path.join(
    installedElectrobunDir,
    ".cache",
    "electrobun.exe",
  );

  mkdirSync(path.dirname(installedBinPath), { recursive: true });
  mkdirSync(path.dirname(installedCachePath), { recursive: true });
  copyFileSync(compiledCliPath, installedBinPath);
  copyFileSync(compiledCliPath, installedCachePath);

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
