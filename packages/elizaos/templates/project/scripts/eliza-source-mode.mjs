#!/usr/bin/env node
/**
 * Source-mode switcher for generated projects, toggling between local elizaOS
 * checkouts and published package dependencies.
 */

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ELIZAOS_PACKAGE_DIST_TAG,
  getElizaGitBranch,
  getElizaGitUrl,
  getElizaosPackageSpecifier,
  setMarkedElizaSourceMode,
} from "./lib/eliza-source-mode.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cleanupHelperPath = path.join(__dirname, "rm-path-recursive.mjs");

function usage() {
  console.log(`usage:
  node scripts/eliza-source-mode.mjs local [--install]
  node scripts/eliza-source-mode.mjs packages [--install]

Modes:
  local      Clone or reuse ./eliza and prefer in-repo elizaOS sources.
  packages   Use published @elizaos/* packages. Defaults to ${DEFAULT_ELIZAOS_PACKAGE_DIST_TAG}.

Environment:
  ELIZA_SOURCE=local|packages
  ELIZAOS_DIST_TAG=beta|alpha|main|latest|...
  ELIZAOS_VERSION=2.0.0-beta.1
  ELIZA_BRANCH=<branch-for-local-clone>
  ELIZA_GIT_URL=<repo-for-local-clone>`);
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    return { help: true };
  }

  const [mode, ...rest] = argv;
  const options = { help: false, install: false, mode };

  for (const arg of rest) {
    if (arg === "--install") {
      options.install = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function run(command, args, cwd, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
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

function removePathRecursive(targetPath) {
  const result = spawnSync(process.execPath, [cleanupHelperPath, targetPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `rm-path-recursive failed for ${targetPath} with status ${result.status}`,
    );
  }
}

async function cloneLocalElizaIfMissing(env) {
  const elizaRoot = path.join(repoRoot, "eliza");
  if (fs.existsSync(elizaRoot)) {
    // A complete clone has a .git directory. A clone that was interrupted
    // mid-transfer (the network reset this guards against) can leave a partial
    // tree behind; reusing it would silently build against a broken checkout,
    // so treat a partial directory as missing and re-clone.
    if (fs.existsSync(path.join(elizaRoot, ".git"))) return;
    console.log(
      "[eliza-source-mode] removing partial eliza/ checkout before re-clone",
    );
    removePathRecursive(elizaRoot);
  }

  const gitUrl = getElizaGitUrl(env);
  const branch = getElizaGitBranch(env);
  // Shallow, single-branch, tag-free clone. The elizaOS monorepo carries a
  // multi-GB history (benchmarks, OS images, model assets); a full clone often
  // resets mid-transfer on slower links ("RPC failed; curl 56 ... early EOF;
  // fetch-pack: invalid index-pack output"). Source mode only needs the working
  // tree at the branch tip — no history, no tags — so --depth 1 cuts the
  // transfer by orders of magnitude and avoids the giant pack entirely.
  const args = [
    "clone",
    "--branch",
    branch,
    "--single-branch",
    "--depth",
    "1",
    "--no-tags",
    gitUrl,
    "eliza",
  ];
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(
      `[eliza-source-mode] cloning ${gitUrl}#${branch} into eliza/ (shallow, attempt ${attempt}/${maxAttempts})`,
    );
    try {
      await run("git", args, repoRoot, env);
      return;
    } catch (error) {
      // git removes its own target dir on a failed clone, but guard against a
      // killed process leaving a partial tree behind.
      removePathRecursive(elizaRoot);
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt === maxAttempts) {
        throw new Error(
          `git clone failed after ${maxAttempts} attempts: ${detail}. ` +
            "This is usually a network interruption while pulling the elizaOS " +
            "repository. Re-run the command, or pre-clone it manually with " +
            `\`git clone --depth 1 --branch ${branch} ${gitUrl} eliza\`.`,
        );
      }
      console.warn(
        `[eliza-source-mode] clone attempt ${attempt} failed (${detail}); retrying…`,
      );
    }
  }
}

async function runLocalMode(options) {
  const env = {
    ...process.env,
    ELIZA_SOURCE: "local",
    ELIZA_SKIP_LOCAL_UPSTREAMS: "",
  };

  await cloneLocalElizaIfMissing(env);
  if (options.install) {
    await run("bun", ["install"], path.join(repoRoot, "eliza"), env);
    await run("bun", ["install"], repoRoot, env);
  }
  setMarkedElizaSourceMode(repoRoot, "local");
  console.log("[eliza-source-mode] local elizaOS source mode is ready.");
}

async function runPackageMode(options) {
  const env = {
    ...process.env,
    ELIZA_SOURCE: "packages",
    ELIZA_SKIP_LOCAL_UPSTREAMS: "1",
  };

  setMarkedElizaSourceMode(repoRoot, "packages");
  if (options.install) {
    await run("bun", ["install", "--no-frozen-lockfile"], repoRoot, env);
  }
  console.log(
    `[eliza-source-mode] package elizaOS mode is ready using ${getElizaosPackageSpecifier(env)}.`,
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.mode) {
    usage();
    return;
  }

  if (options.mode === "local") {
    await runLocalMode(options);
    return;
  }
  if (
    ["packages", "package", "npm", "registry", "published"].includes(
      options.mode,
    )
  ) {
    await runPackageMode(options);
    return;
  }

  throw new Error(`Unsupported mode: ${options.mode}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
