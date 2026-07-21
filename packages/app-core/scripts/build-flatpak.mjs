#!/usr/bin/env node
/**
 * Builds a Flatpak from the current checkout's compiled agent and materialized
 * Linux dependency closure. The staging step runs outside flatpak-builder so
 * the sandbox consumes only local, validated inputs and never substitutes an
 * older npm release for the source revision being packaged.
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const FLATPAK_DIR = resolve(HERE, "../packaging/flatpak");
const OUTPUT_DIR = resolve(ROOT, "dist-flatpak");
const RUNTIME_DIR = resolve(OUTPUT_DIR, "runtime");
const REPO_DIR = resolve(OUTPUT_DIR, "repo");
const BUILD_DIR = resolve(OUTPUT_DIR, "build");
const BUNDLE_PATH = resolve(OUTPUT_DIR, "elizaos-app.flatpak");
const AGENT_DIR = resolve(ROOT, "packages/agent");
const AGENT_ENTRYPOINT = resolve(RUNTIME_DIR, "packages/agent/dist/bin.js");
const APP_ID = "ai.elizaos.App";

function parseVariant() {
  const argIdx = process.argv.indexOf("--variant");
  const fromArg = argIdx >= 0 ? process.argv[argIdx + 1] : undefined;
  const raw = fromArg || process.env.ELIZA_BUILD_VARIANT || "store";
  const variant = raw.toLowerCase();
  if (variant !== "store" && variant !== "direct") {
    throw new Error(
      `ELIZA_BUILD_VARIANT must be 'store' or 'direct' (got '${raw}').`,
    );
  }
  return variant;
}

function manifestFor(variant) {
  const file =
    variant === "store" ? "ai.elizaos.App.store.yml" : "ai.elizaos.App.yml";
  const path = resolve(FLATPAK_DIR, file);
  if (!existsSync(path)) {
    throw new Error(`Manifest not found: ${path}`);
  }
  return path;
}

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...opts,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${cmd} exited with status ${result.status}`);
  }
}

function capture(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${cmd} exited with status ${result.status}: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout.trim();
}

function which(cmd) {
  const result = spawnSync("which", [cmd], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readSourceProvenance() {
  const revisionResult = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (revisionResult.status === 0) {
    return {
      sourceRevision: revisionResult.stdout.trim(),
      sourceDirty: Boolean(capture("git", ["status", "--porcelain"])),
    };
  }

  const sourceRevision = process.env.ELIZA_SOURCE_REVISION?.trim();
  if (!sourceRevision || !/^[0-9a-f]{40}$/i.test(sourceRevision)) {
    throw new Error(
      "source provenance unavailable; build from a Git checkout or set ELIZA_SOURCE_REVISION to the 40-character commit SHA",
    );
  }
  return { sourceRevision, sourceDirty: false };
}

function stageCurrentSourceRuntime() {
  const rootManifest = readJson(resolve(ROOT, "package.json"));
  const agentManifest = readJson(resolve(AGENT_DIR, "package.json"));
  const { sourceRevision, sourceDirty } = readSourceProvenance();
  const requiredNode = `v${rootManifest.engines.node}`;
  if (process.version !== requiredNode) {
    throw new Error(
      `Flatpak staging requires Node ${requiredNode}, detected ${process.version}`,
    );
  }

  run("bun", ["run", "--cwd", "packages/shared", "build"]);
  run("bun", ["run", "--cwd", "packages/agent", "build"]);
  run("node", ["packages/scripts/rm-path-recursive.mjs", RUNTIME_DIR]);

  mkdirSync(resolve(RUNTIME_DIR, "packages/agent"), { recursive: true });
  cpSync(
    resolve(AGENT_DIR, "dist"),
    resolve(RUNTIME_DIR, "packages/agent/dist"),
    {
      recursive: true,
    },
  );
  writeJson(resolve(RUNTIME_DIR, "packages/agent/package.json"), {
    ...agentManifest,
    version: rootManifest.version,
  });
  cpSync(resolve(ROOT, "package.json"), resolve(RUNTIME_DIR, "package.json"));
  cpSync(resolve(ROOT, "plugins.json"), resolve(RUNTIME_DIR, "plugins.json"));

  run("node", [
    "--import",
    "tsx",
    "packages/app-core/scripts/copy-runtime-node-modules.ts",
    "--scan-dir",
    "packages/agent/dist",
    "--target-dist",
    RUNTIME_DIR,
  ]);

  const danglingLink = capture("find", [
    resolve(RUNTIME_DIR, "node_modules"),
    "-xtype",
    "l",
    "-print",
    "-quit",
  ]);
  if (danglingLink) {
    throw new Error(
      `Flatpak runtime contains a dangling link: ${danglingLink}`,
    );
  }

  const expectedElf =
    process.arch === "x64"
      ? "x86-64"
      : process.arch === "arm64"
        ? "ARM aarch64"
        : null;
  if (!expectedElf) {
    throw new Error(
      `Unsupported Flatpak runtime architecture: ${process.arch}`,
    );
  }
  const fileInventory = capture("find", [
    RUNTIME_DIR,
    "-type",
    "f",
    "-exec",
    "file",
    "{}",
    "+",
  ]);
  const foreignElf = fileInventory
    .split("\n")
    .find((line) => line.includes("ELF") && !line.includes(expectedElf));
  if (foreignElf) {
    throw new Error(
      `Flatpak runtime contains a foreign-architecture ELF: ${foreignElf}`,
    );
  }

  const runtimeEnv = {
    ...process.env,
    NODE_PATH: resolve(RUNTIME_DIR, "node_modules"),
  };
  const version = capture(process.execPath, [AGENT_ENTRYPOINT, "--version"], {
    cwd: RUNTIME_DIR,
    env: runtimeEnv,
    timeout: 30_000,
  });
  if (version !== rootManifest.version) {
    throw new Error(
      `Staged Flatpak CLI reported '${version}', expected '${rootManifest.version}'`,
    );
  }
  const help = capture(process.execPath, [AGENT_ENTRYPOINT, "--help"], {
    cwd: RUNTIME_DIR,
    env: runtimeEnv,
    timeout: 30_000,
  });
  if (!help.includes("Usage:") || !help.includes("Commands:")) {
    throw new Error("Staged Flatpak CLI did not produce populated help output");
  }

  writeJson(resolve(RUNTIME_DIR, "flatpak-runtime.json"), {
    version: rootManifest.version,
    sourceRevision,
    sourceDirty,
    platform: process.platform,
    architecture: process.arch,
    buildNode: process.version,
    runtimeNode: requiredNode,
  });

  console.log(`\nFlatpak runtime staged from ${sourceRevision}`);
  console.log(`  version: ${version}`);
  console.log(`  path:    ${RUNTIME_DIR}`);
}

async function main() {
  if (process.platform !== "linux") {
    console.error(
      `build-flatpak: skipping — Flatpak only builds on Linux (detected ${process.platform})`,
    );
    process.exit(0);
  }

  const variant = parseVariant();
  const manifest = manifestFor(variant);
  const stageOnly = process.argv.includes("--stage-only");

  if (!stageOnly && (!which("flatpak-builder") || !which("flatpak"))) {
    throw new Error(
      "flatpak and flatpak-builder are required; install them with the host package manager",
    );
  }
  if (!which("bun") || !which("file")) {
    throw new Error(
      "bun and file are required to stage the current-source runtime",
    );
  }

  console.log(`build-flatpak: variant=${variant}`);
  console.log(`build-flatpak: manifest=${manifest}`);
  stageCurrentSourceRuntime();
  if (stageOnly) {
    console.log("\nbuild-flatpak: stage-only validation complete.");
    return;
  }

  run(
    "flatpak-builder",
    [
      `--repo=${REPO_DIR}`,
      "--force-clean",
      "--user",
      "--install-deps-from=flathub",
      BUILD_DIR,
      manifest,
    ],
    { cwd: FLATPAK_DIR },
  );
  run("flatpak", ["build-bundle", REPO_DIR, BUNDLE_PATH, APP_ID], {
    cwd: FLATPAK_DIR,
  });

  console.log("\nbuild-flatpak: done.");
  console.log(`  variant: ${variant}`);
  console.log(`  bundle:  ${BUNDLE_PATH}`);
  console.log(`  install: flatpak --user install ${BUNDLE_PATH}`);
}

main().catch((error) => {
  // error-policy:J1 CLI boundary reports one actionable failure and exits non-zero.
  console.error(
    "build-flatpak: failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(1);
});
