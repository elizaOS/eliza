#!/usr/bin/env node

/**
 * scripts/pack-upstreams.mjs
 * Packs upstream packages from vendored checkout to test without workspace links.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const ROOT = resolveRepoRootFromImportMeta(import.meta.url);
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");
const ELIZA_ROOT = existsSync(
  path.join(ROOT, "packages", "core", "package.json"),
)
  ? ROOT
  : path.join(ROOT, "eliza");

// Target packages to pack. These are the package boundary that Milady consumes
// when it runs without a repo-local eliza checkout.
const TARGETS = [
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
    dir: path.join(ELIZA_ROOT, "plugins", "plugin-sql", "typescript"),
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

  for (const target of TARGETS) {
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
    await runCommand(
      "npm",
      ["pack", "--pack-destination", ARTIFACTS_DIR],
      packDir,
    );

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
