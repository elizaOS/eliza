#!/usr/bin/env node
/**
 * Build every Capacitor / Electrobun native plugin package under
 * `eliza/packages/native/plugins/` whose `pkg.elizaos.platforms` allowlist
 * matches the current build host (or omits an OS allowlist entirely).
 *
 * Designed to be invoked from any elizaOS-based fork:
 *   node eliza/packages/app-core/scripts/build-native-plugins.mjs
 *
 * Forks that previously used `pkg.eliza.platforms` should rename to
 * `pkg.elizaos.platforms`, or wrap this script with a 1-line preprocessor
 * that mirrors the field before invocation.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CAPACITOR_PLUGIN_NAMES,
  NATIVE_PLUGINS_ROOT,
} from "./lib/capacitor-plugin-names.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const verbosePluginBuild = process.env.ELIZA_VERBOSE_PLUGIN_BUILD === "1";

// Only these values in a plugin's `platforms` array are treated as build-host
// gates. Anything else (e.g. "node", "browser") is a runtime hint and does
// not block building on the current host.
export const OS_PLATFORMS = new Set(["darwin", "linux", "win32"]);

/**
 * Decide whether a plugin should be built on the current host, based on the
 * `elizaos.platforms` allowlist in its package.json, or by detecting Capacitor
 * mobile plugins via their peer dependency.
 *
 * Rules (in order):
 * 1. Explicit `platforms` pure-OS allowlist → build only when host is listed.
 * 2. `platforms` mixing runtime hints (e.g. "node", "browser") → build everywhere.
 * 3. No `platforms` but `@capacitor/core` peer dep → mobile-only, skip on desktop.
 * 4. No signal → build everywhere.
 *
 * @param {unknown} pkg          — parsed package.json (or undefined)
 * @param {string}  hostPlatform — the current `process.platform` value
 * @returns {boolean}
 */
export function shouldBuildPluginForHost(pkg, hostPlatform) {
  const platforms = pkg && typeof pkg === "object" && pkg.elizaos?.platforms;
  if (Array.isArray(platforms) && platforms.length > 0) {
    const isPureOsAllowlist = platforms.every((p) => OS_PLATFORMS.has(p));
    if (!isPureOsAllowlist) {
      return true;
    }
    return platforms.includes(hostPlatform);
  }
  // No explicit metadata — @capacitor/core peer dep is a reliable mobile-only
  // signal (every proper Capacitor plugin lists it). Skip on all desktop hosts.
  const peerDeps =
    (pkg && typeof pkg === "object" && pkg.peerDependencies) ?? {};
  if ("@capacitor/core" in peerDeps) {
    return false;
  }
  return true;
}

const NATIVE_PLUGIN_DIR_PREFIX = "plugin-native-";
const WORKSPACE_RUNTIME_PACKAGES = new Map([
  [
    "@elizaos/core",
    path.resolve(NATIVE_PLUGINS_ROOT, "..", "packages", "core"),
  ],
]);

function pluginDirFor(pluginsDir, name) {
  return path.join(pluginsDir, `${NATIVE_PLUGIN_DIR_PREFIX}${name}`);
}

function readPluginPackageJson(pluginsDir, name) {
  const pkgPath = path.join(pluginDirFor(pluginsDir, name), "package.json");
  const raw = fs.readFileSync(pkgPath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `[plugins] ${pkgPath} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
    });
    child.on("error", (error) => {
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited due to signal ${signal}`));
        return;
      }
      if ((code ?? 1) !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }
      resolve();
    });
  });
}

function logVerbose(message) {
  if (verbosePluginBuild) {
    console.log(message);
  }
}

// Force a full rebuild regardless of on-disk freshness (escape hatch for the
// rare case where output is stale but its mtime says otherwise).
const forcePluginBuild = process.env.ELIZA_FORCE_PLUGIN_BUILD === "1";

// Files outside `src/` that, when changed, invalidate a package's build.
const BUILD_INPUT_FILES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "rollup.config.mjs",
  "build.ts",
];
// Directories under `src/` that hold build-generated artifacts, not authored
// inputs. Some packages (notably @elizaos/core) emit generated TS and `.d.ts`
// back into `src/` during their build, so these must be excluded when deciding
// whether a package's source has changed.
const BUILD_INPUT_IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".cache",
  "generated",
]);

function isDeclarationFile(name) {
  return name.endsWith(".d.ts") || name.endsWith(".d.ts.map");
}

/**
 * Largest file mtime (ms) under a path, walking directories iteratively.
 * Symlinks are skipped to avoid cycles. Returns 0 when nothing is found.
 *
 * @param {string} target
 * @param {object} [options]
 * @param {Set<string>} [options.ignoreDirs] directory basenames to skip
 * @param {boolean} [options.skipDeclarations] ignore emitted `.d.ts(.map)` files
 * @returns {number}
 */
function newestMtimeMs(target, options = {}) {
  const { ignoreDirs, skipDeclarations = false } = options;
  let newest = 0;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      if (ignoreDirs?.has(path.basename(current))) {
        continue;
      }
      let entries;
      try {
        entries = fs.readdirSync(current);
      } catch {
        continue;
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry));
      }
    } else if (skipDeclarations && isDeclarationFile(path.basename(current))) {
      // emitted declaration file — a build output, not an authored input
    } else if (stat.mtimeMs > newest) {
      newest = stat.mtimeMs;
    }
  }
  return newest;
}

/**
 * A package build is "fresh" when its `dist/` output exists and every output
 * file is at least as new as the newest build input (`src/` plus the config
 * files in {@link BUILD_INPUT_FILES}). Lets warm dev boots skip rebuilding
 * unchanged packages — the single largest boot-time cost.
 *
 * @param {string} packageDir absolute path to the package root
 * @returns {boolean}
 */
function isPackageBuildFresh(packageDir) {
  if (forcePluginBuild) {
    return false;
  }
  const distDir = path.join(packageDir, "dist");
  let distEntries;
  try {
    distEntries = fs.readdirSync(distDir);
  } catch {
    return false;
  }
  if (distEntries.length === 0) {
    return false;
  }
  const outputNewest = newestMtimeMs(distDir);
  if (outputNewest === 0) {
    return false;
  }

  let inputNewest = 0;
  const srcDir = path.join(packageDir, "src");
  if (fs.existsSync(srcDir)) {
    inputNewest = newestMtimeMs(srcDir, {
      ignoreDirs: BUILD_INPUT_IGNORED_DIRS,
      skipDeclarations: true,
    });
  }
  for (const file of BUILD_INPUT_FILES) {
    try {
      const stat = fs.statSync(path.join(packageDir, file));
      if (stat.mtimeMs > inputNewest) {
        inputNewest = stat.mtimeMs;
      }
    } catch {
      // input file absent — not part of this package's build
    }
  }
  // No recognizable inputs — build to stay safe.
  if (inputNewest === 0) {
    return false;
  }
  return outputNewest >= inputNewest;
}

function hasPackageDependency(pkg, packageName) {
  if (!pkg || typeof pkg !== "object") return false;
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const deps = pkg[field];
    if (deps && typeof deps === "object" && packageName in deps) {
      return true;
    }
  }
  return false;
}

async function buildWorkspaceRuntimePackagesForPlugins(pluginEntries) {
  const requiredPackages = new Set();
  for (const { pkg } of pluginEntries) {
    for (const packageName of WORKSPACE_RUNTIME_PACKAGES.keys()) {
      if (hasPackageDependency(pkg, packageName)) {
        requiredPackages.add(packageName);
      }
    }
  }

  for (const packageName of requiredPackages) {
    const packageDir = WORKSPACE_RUNTIME_PACKAGES.get(packageName);
    const packageJsonPath = path.join(packageDir, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      throw new Error(
        `[plugins] ${packageName} dependency is required but ${packageJsonPath} does not exist`,
      );
    }
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    if (!pkg?.scripts?.build) {
      throw new Error(
        `[plugins] ${packageName} dependency is required but has no build script`,
      );
    }
    if (isPackageBuildFresh(packageDir)) {
      console.log(
        `[plugins] workspace dependency ${packageName} up to date — skipping`,
      );
      continue;
    }
    console.log(`[plugins] building workspace dependency ${packageName}`);
    await run("bun", ["run", "build"], packageDir);
  }
}

async function main() {
  const pluginsDir = NATIVE_PLUGINS_ROOT;
  const pluginNames = CAPACITOR_PLUGIN_NAMES;

  const skipPlugins =
    process.env.SKIP_NATIVE_PLUGINS === "1" || process.env.CI === "true";

  if (skipPlugins) {
    console.log(
      "[plugins] skipping native plugin builds (CI or explicitly disabled)",
    );
    return;
  }

  const buildablePlugins = pluginNames
    .map((name) => ({ name, pkg: readPluginPackageJson(pluginsDir, name) }))
    .filter(({ name, pkg }) => {
      // Type-only / source-consumed packages (e.g. shared-types) have no build
      // script. Skip them so `bun run build` does not abort the whole batch.
      if (!pkg?.scripts?.build) {
        logVerbose(`[plugin:${name}] skipping — no build script declared`);
        return false;
      }
      if (shouldBuildPluginForHost(pkg, process.platform)) {
        return true;
      }
      const platforms = pkg?.elizaos?.platforms;
      logVerbose(
        `[plugin:${name}] skipping — declares platforms=${JSON.stringify(
          platforms,
        )}, host is ${process.platform}`,
      );
      return false;
    });

  await buildWorkspaceRuntimePackagesForPlugins(buildablePlugins);

  let builtCount = 0;
  let freshCount = 0;
  await Promise.all(
    buildablePlugins.map(async ({ name }) => {
      const pluginDir = pluginDirFor(pluginsDir, name);
      if (isPackageBuildFresh(pluginDir)) {
        freshCount += 1;
        logVerbose(`[plugin:${name}] up to date — skipping`);
        return;
      }
      builtCount += 1;
      logVerbose(`[plugin:${name}] building...`);
      await run("bun", ["run", "build"], pluginDir);
      logVerbose(`[plugin:${name}] done`);
    }),
  );
  console.log(
    `[plugins] native plugins: built ${builtCount}, skipped ${freshCount} (up to date)`,
  );
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptFile);

if (isDirectRun) {
  await main();
}
