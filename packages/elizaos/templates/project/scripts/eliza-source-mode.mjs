#!/usr/bin/env node

import { spawn } from "node:child_process";
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

async function cloneLocalElizaIfMissing(env) {
  const elizaRoot = path.join(repoRoot, "eliza");
  if (fs.existsSync(elizaRoot)) return;

  const gitUrl = getElizaGitUrl(env);
  const branch = getElizaGitBranch(env);
  console.log(`[eliza-source-mode] cloning ${gitUrl}#${branch} into eliza/`);
  await run(
    "git",
    ["clone", "--branch", branch, "--single-branch", gitUrl, "eliza"],
    repoRoot,
    env,
  );
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
