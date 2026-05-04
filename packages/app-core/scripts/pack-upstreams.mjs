#!/usr/bin/env node

/**
 * scripts/pack-upstreams.mjs
 * Packs upstream packages from vendored checkout to test without workspace links.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");

// Target packages to pack (MVP for Phase 5).
// @elizaos/core now contains the orchestrator runtime, so pairing it with one
// vendored plugin proves both core and plugin tarballs build cleanly.
const TARGETS = [
  path.join(ROOT, "eliza", "packages", "typescript"), // @elizaos/core
  path.join(ROOT, "eliza", "plugins", "plugin-sql", "typescript"), // representative vendored plugin
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

async function packUpstreams() {
  if (!existsSync(ARTIFACTS_DIR)) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }

  for (const pkgDir of TARGETS) {
    if (!existsSync(pkgDir)) {
      console.warn(`[pack-upstreams] Skipping missing directory: ${pkgDir}`);
      continue;
    }

    const pkgJson = readPackageJson(pkgDir);
    if (!pkgJson) {
      console.warn(`[pack-upstreams] No package.json found in ${pkgDir}`);
      continue;
    }

    console.log(`\n[pack-upstreams] === Packing ${pkgJson.name} ===`);

    // Some packages require build before pack if dist isn't precompiled
    if (pkgJson.scripts?.build && !existsSync(path.join(pkgDir, "dist"))) {
      console.log(`[pack-upstreams] Building ${pkgJson.name}...`);
      await runCommand("bun", ["run", "build"], pkgDir);
    }

    // We use npm pack as it handles prepack correctly and is standard.
    // Bun pm pack also works but npm pack is generally more tested for tarball generation.
    console.log(`[pack-upstreams] Packing ${pkgJson.name}...`);
    // Output directly into the package directory
    await runCommand("npm", ["pack"], pkgDir);

    // Move the generated tarball to ARTIFACTS_DIR
    const expectedTarballName = `${pkgJson.name.replace("@", "").replace("/", "-")}-${pkgJson.version}.tgz`;
    const tarballPath = path.join(pkgDir, expectedTarballName);
    const destTarballPath = path.join(ARTIFACTS_DIR, expectedTarballName);

    if (existsSync(tarballPath)) {
      renameSync(tarballPath, destTarballPath);
      console.log(
        `[pack-upstreams] Packed tarball moved to ${destTarballPath}`,
      );
    } else {
      console.warn(
        `[pack-upstreams] Tarball not found at expected path: ${tarballPath}. Ensure pack succeeded.`,
      );
    }
  }

  console.log("\n[pack-upstreams] Done packing all targets.");
}

packUpstreams().catch((error) => {
  console.error(`\n[pack-upstreams] Error: ${error.message}`);
  process.exit(1);
});
