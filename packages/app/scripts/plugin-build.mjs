#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  CAPACITOR_PLUGIN_NAMES,
  NATIVE_PLUGINS_ROOT,
} from "./capacitor-plugin-names.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const __dirname = path.dirname(scriptFile);
const _appDir = path.resolve(__dirname, "..");
const verbosePluginBuild =
  process.env.MILADY_VERBOSE_PLUGIN_BUILD === "1" ||
  process.env.ELIZA_VERBOSE_PLUGIN_BUILD === "1";

// Only these values in a plugin's `platforms` array are treated as build-host
// gates. Anything else (e.g. "node", "browser") is a runtime hint and does
// not block building on the current host.
export const OS_PLATFORMS = new Set(["darwin", "linux", "win32"]);

/**
 * Decide whether a plugin should be built on the current host, based on the
 * `milady.platforms` / `elizaos.platforms` allowlist in its package.json, or
 * by detecting Capacitor mobile plugins via their peer dependency.
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
  const platforms =
    (pkg && typeof pkg === "object" && pkg.milady?.platforms) ??
    (pkg && typeof pkg === "object" && pkg.elizaos?.platforms);
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

function readPluginPackageJson(pluginsDir, name) {
  const pkgPath = path.join(pluginsDir, name, "package.json");
  try {
    return JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return undefined;
  }
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit",
      env: process.env,
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

  const buildablePluginNames = pluginNames.filter((name) => {
    const pkg = readPluginPackageJson(pluginsDir, name);
    if (shouldBuildPluginForHost(pkg, process.platform)) {
      return true;
    }
    const platforms = pkg?.milady?.platforms ?? pkg?.elizaos?.platforms;
    logVerbose(
      `[plugin:${name}] skipping — declares platforms=${JSON.stringify(
        platforms,
      )}, host is ${process.platform}`,
    );
    return false;
  });

  await Promise.all(
    buildablePluginNames.map(async (name) => {
      logVerbose(`[plugin:${name}] building...`);
      await run("bun", ["run", "build"], path.join(pluginsDir, name));
      logVerbose(`[plugin:${name}] done`);
    }),
  );
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptFile);

if (isDirectRun) {
  await main();
}
