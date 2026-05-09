#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
/**
 * Post-install setup for @elizaos/plugin-browser:
 *
 * 1. Builds the stagehand-server if dist/index.js is missing but source exists.
 *
 * 2. Symlinks the installed package's `dist/server` to the workspace's
 *    stagehand-server source (the npm package doesn't ship the server).
 *
 * 3. Copies the workspace's patched process-manager.js over the npm
 *    package's version (adds probe/reuse, port management, removes Docker
 *    env defaults).
 *
 * Run automatically via the `postinstall` hook, or manually:
 *   node scripts/link-browser-server.mjs
 */
import {
  copyFileSync,
  existsSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolveRepoRootFromImportMeta(import.meta.url);

// ── Resolve plugin-browser package ───────────────────────────────────────────

let pluginRoot;
try {
  const req = createRequire(join(repoRoot, "package.json"));
  const pkgJson = req.resolve("@elizaos/plugin-browser/package.json");
  pluginRoot = dirname(pkgJson);
} catch {
  console.log(
    "[link-browser-server] @elizaos/plugin-browser not installed — skipping",
  );
  process.exit(0);
}

// ── 1. Build stagehand-server if needed ─────────────────────────────────────

const stagehandDir = join(
  repoRoot,
  "plugins",
  "plugin-browser",
  "stagehand-server",
);
const stagehandIndex = join(stagehandDir, "dist", "index.js");
const stagehandSrc = join(stagehandDir, "src", "index.ts");

if (!existsSync(stagehandIndex) && existsSync(stagehandSrc)) {
  console.log(
    "[link-browser-server] Stagehand server not built — building now...",
  );
  try {
    // Install deps if node_modules is missing, then compile TypeScript
    if (!existsSync(join(stagehandDir, "node_modules"))) {
      execSync("bun install --ignore-scripts", {
        cwd: stagehandDir,
        stdio: "inherit",
      });
    }
    // Resolve tsc: prefer local node_modules/.bin, then bunx
    const localTsc = join(stagehandDir, "node_modules", ".bin", "tsc");
    if (existsSync(localTsc)) {
      execFileSync(localTsc, [], { cwd: stagehandDir, stdio: "inherit" });
    } else {
      execFileSync("bunx", ["tsc"], {
        cwd: stagehandDir,
        stdio: "inherit",
      });
    }
    console.log("[link-browser-server] Stagehand server built successfully");
  } catch (err) {
    console.error(
      `[link-browser-server] Failed to build stagehand-server: ${err.message ?? err}`,
    );
  }
}

// ── 2. Symlink stagehand-server ──────────────────────────────────────────────

if (existsSync(stagehandIndex)) {
  const serverLink = join(pluginRoot, "dist", "server");

  let needsLink = true;
  if (existsSync(serverLink)) {
    try {
      const target = readlinkSync(serverLink);
      if (target === stagehandDir) {
        console.log("[link-browser-server] Symlink already up to date");
        needsLink = false;
      } else {
        // Stale symlink — remove and recreate
        unlinkSync(serverLink);
      }
    } catch {
      // Not a symlink (real directory) — leave it alone
      console.log(
        "[link-browser-server] dist/server already exists as a directory — skipping symlink",
      );
      needsLink = false;
    }
  }

  if (needsLink) {
    try {
      symlinkSync(stagehandDir, serverLink, "dir");
      console.log(
        `[link-browser-server] Linked: ${serverLink} -> ${stagehandDir}`,
      );
    } catch (err) {
      console.error(`[link-browser-server] Failed to create symlink: ${err}`);
    }
  }
} else {
  console.log(
    `[link-browser-server] Stagehand server not found at ${stagehandDir} — skipping symlink`,
  );
}

// ── 3. Copy patched process-manager.js ───────────────────────────────────────
// The workspace has a fixed process-manager that adds port probing/reuse,
// removes Docker env defaults, and handles EADDRINUSE properly.

const patchedPm = join(
  repoRoot,
  "plugins",
  "plugin-browser",
  "typescript",
  "src",
  "services",
  "process-manager.patched.js",
);
const targetPm = join(pluginRoot, "dist", "services", "process-manager.js");

if (existsSync(patchedPm) && existsSync(targetPm)) {
  try {
    copyFileSync(patchedPm, targetPm);
    console.log("[link-browser-server] Copied patched process-manager.js");
  } catch (err) {
    console.error(
      `[link-browser-server] Failed to copy process-manager.js: ${err}`,
    );
  }
} else {
  console.log(
    "[link-browser-server] No patched process-manager.js found — skipping",
  );
}
