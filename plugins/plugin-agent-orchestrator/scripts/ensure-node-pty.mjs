#!/usr/bin/env node
import { execSync } from "node:child_process";
/**
 * Ensures node-pty's native addon is available and spawn-helper is executable.
 *
 * node-pty >=1.0 ships prebuilt binaries under `prebuilds/<platform>-<arch>/`.
 * `bun install` extracts tarballs but can strip execute permissions from the
 * `spawn-helper` Mach-O executable, causing `posix_spawnp failed` at runtime.
 *
 * This script:
 *  1. Looks for prebuilt binaries first (node-pty >=1.0).
 *  2. Falls back to checking for a node-gyp compiled binary (older versions).
 *  3. Ensures `spawn-helper` has execute permissions on Unix platforms.
 */
import { chmodSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Check both direct and nested (inside pty-manager) locations
const candidates = [
  resolve(root, "node_modules", "node-pty"),
  resolve(root, "node_modules", "pty-manager", "node_modules", "node-pty"),
];

/** Ensure all spawn-helper binaries under prebuilds/ are executable. */
function fixSpawnHelperPermissions(ptyDir) {
  const prebuildsDir = resolve(ptyDir, "prebuilds");
  if (!existsSync(prebuildsDir)) return;

  let fixed = 0;
  for (const platform of readdirSync(prebuildsDir)) {
    const helper = join(prebuildsDir, platform, "spawn-helper");
    if (existsSync(helper)) {
      try {
        chmodSync(helper, 0o755);
        fixed++;
      } catch {
        // Ignore permission errors (e.g. read-only filesystem)
      }
    }
  }
  if (fixed > 0) {
    console.log(
      `[ensure-node-pty] Fixed spawn-helper permissions (${fixed} platform(s)) at ${ptyDir}`,
    );
  }
}

for (const ptyDir of candidates) {
  if (!existsSync(ptyDir)) continue;

  // node-pty >=1.0: prebuilds
  const arch = process.arch;
  const platform = process.platform;
  const prebuildBinary = resolve(
    ptyDir,
    "prebuilds",
    `${platform}-${arch}`,
    "pty.node",
  );

  if (existsSync(prebuildBinary)) {
    console.log(
      `[ensure-node-pty] Prebuild binary found at ${ptyDir} (${platform}-${arch})`,
    );
    fixSpawnHelperPermissions(ptyDir);
    continue;
  }

  // Older node-pty: node-gyp compiled binary
  const gypBinary = resolve(ptyDir, "build", "Release", "pty.node");
  if (existsSync(gypBinary)) {
    console.log(`[ensure-node-pty] Native addon already built at ${ptyDir}`);
    fixSpawnHelperPermissions(ptyDir);
    continue;
  }

  // No binary found — try node-gyp rebuild
  console.log(`[ensure-node-pty] Building native addon at ${ptyDir}...`);
  try {
    execSync("node-gyp rebuild", {
      cwd: ptyDir,
      stdio: "inherit",
      timeout: 120_000,
    });
    console.log("[ensure-node-pty] Build complete.");
  } catch (err) {
    console.error(
      "[ensure-node-pty] Failed to build node-pty native addon.",
      "PTY-based coding agents will not work.",
      err.message,
    );
  }

  // Fix permissions even after rebuild
  fixSpawnHelperPermissions(ptyDir);
}
