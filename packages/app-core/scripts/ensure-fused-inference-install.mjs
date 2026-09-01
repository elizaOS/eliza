#!/usr/bin/env bun
/**
 * Ensures a source checkout can run the fused desktop inference backend after
 * `bun install`. The installer initializes the pinned native submodule,
 * provisions missing host build prerequisites where supported, and delegates
 * freshness verification plus staging to the canonical app-core build script.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(scriptDir, "..", "..", "..");

export const FUSED_EMBEDDING_ARTIFACT = Object.freeze({
  filename: "gte-small_fp16.gguf",
  repo: "ChristianAzinn/gte-small-gguf",
  revision: "208c4701ee35ad296b92918e02c03aebfaa6be6f",
  sha256: "6c3d85a9af8ef795854d28cd25fa14bbf1638243d6c094d6f4c673b50b69271d",
  size: 67_308_128,
});

function log(message) {
  console.log(`[ensure-fused-inference] ${message}`);
}

function commandResult(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
    env: options.env,
  });
}

function commandAvailable(command, args = ["--version"]) {
  const result = commandResult(command, args);
  return !result.error && result.status === 0;
}

function runChecked(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  const result = commandResult(command, args, {
    ...options,
    stdio: options.stdio ?? "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited ${result.status ?? result.signal}`);
  }
}

function resolveStateDir(env) {
  const explicit = env.ELIZA_STATE_DIR?.trim();
  if (explicit) {
    return path.isAbsolute(explicit)
      ? explicit
      : path.join(os.homedir(), explicit);
  }
  const namespace = env.ELIZA_NAMESPACE?.trim() || "eliza";
  const xdg = env.XDG_STATE_HOME?.trim();
  if (xdg) {
    return path.isAbsolute(xdg)
      ? path.join(xdg, namespace)
      : path.join(os.homedir(), xdg, namespace);
  }
  return path.join(os.homedir(), ".local", "state", namespace);
}

export function resolveEmbeddingArtifactPath({
  env = process.env,
  repoRoot = defaultRepoRoot,
} = {}) {
  const configured = env.MODELS_DIR?.trim();
  const modelsDir = configured
    ? path.resolve(repoRoot, configured)
    : path.join(resolveStateDir(env), "models");
  return path.join(modelsDir, FUSED_EMBEDDING_ARTIFACT.filename);
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function validateArtifactBytes(bytes, artifact) {
  if (bytes.byteLength !== artifact.size) {
    throw new Error(
      `${artifact.filename} size mismatch: expected ${artifact.size}, received ${bytes.byteLength}`,
    );
  }
  const digest = sha256Bytes(bytes);
  if (digest !== artifact.sha256) {
    throw new Error(
      `${artifact.filename} SHA-256 mismatch: expected ${artifact.sha256}, received ${digest}`,
    );
  }
}

export async function ensureEmbeddingArtifact({
  env = process.env,
  repoRoot = defaultRepoRoot,
  fetchImpl = fetch,
  artifact = FUSED_EMBEDDING_ARTIFACT,
} = {}) {
  const targetPath = resolveEmbeddingArtifactPath({ env, repoRoot });
  if (existsSync(targetPath)) {
    const current = readFileSync(targetPath);
    if (
      current.byteLength === artifact.size &&
      sha256Bytes(current) === artifact.sha256
    ) {
      log(`embedding model is current at ${targetPath}`);
      return { status: "ready", path: targetPath, downloaded: false };
    }
    log(`replacing stale embedding model at ${targetPath}`);
  }

  const url = `https://huggingface.co/${artifact.repo}/resolve/${artifact.revision}/${artifact.filename}`;
  log(
    `downloading ${artifact.filename} from pinned revision ${artifact.revision}`,
  );
  const response = await fetchImpl(url, {
    headers: env.HF_TOKEN
      ? { Authorization: `Bearer ${env.HF_TOKEN}` }
      : undefined,
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `failed to download ${artifact.filename}: HTTP ${response.status}`,
    );
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > 0 &&
    declaredLength !== artifact.size
  ) {
    throw new Error(
      `${artifact.filename} Content-Length mismatch: expected ${artifact.size}, received ${declaredLength}`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  validateArtifactBytes(bytes, artifact);
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const partialPath = `${targetPath}.partial-${process.pid}`;
  try {
    writeFileSync(partialPath, bytes, { mode: 0o644 });
    renameSync(partialPath, targetPath);
  } finally {
    rmSync(partialPath, { force: true });
  }
  log(`installed verified embedding model at ${targetPath}`);
  return { status: "ready", path: targetPath, downloaded: true };
}

function linuxPackagesMissing() {
  const packages = [];
  if (!commandAvailable("cmake")) packages.push("cmake");
  if (!commandAvailable("c++") && !commandAvailable("g++")) {
    packages.push("build-essential");
  }
  if (!commandAvailable("ninja", ["--version"])) packages.push("ninja-build");
  if (!commandAvailable("pkg-config", ["--version"])) {
    packages.push("pkg-config");
  }
  const espeak = commandResult("pkg-config", ["--exists", "espeak-ng"]);
  if (espeak.status !== 0) packages.push("libespeak-ng-dev");
  return packages;
}

function provisionLinuxPackages(packages, run = runChecked) {
  if (packages.length === 0) return;
  if (!commandAvailable("apt-get", ["--version"])) {
    throw new Error(
      `missing native build prerequisites: ${packages.join(", ")}. ` +
        "Install the equivalent packages for this Linux distribution and rerun bun install.",
    );
  }

  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const prefix = root ? [] : ["-n"];
  if (!root) {
    const sudo = commandResult("sudo", ["-n", "true"]);
    if (sudo.error || sudo.status !== 0) {
      throw new Error(
        `missing native build prerequisites: ${packages.join(", ")}. ` +
          `Run \`sudo apt-get update && sudo apt-get install -y ${packages.join(" ")}\`, then rerun bun install.`,
      );
    }
  }

  const command = root ? "apt-get" : "sudo";
  run(command, [...prefix, "apt-get", "update"].slice(root ? 1 : 0));
  run(
    command,
    [...prefix, "apt-get", "install", "-y", ...packages].slice(root ? 1 : 0),
  );
}

function provisionMacPackages(run = runChecked) {
  const packages = [];
  if (!commandAvailable("cmake")) packages.push("cmake");
  if (!commandAvailable("ninja", ["--version"])) packages.push("ninja");
  if (!commandAvailable("pkg-config", ["--version"]))
    packages.push("pkg-config");
  const espeak = commandResult("pkg-config", ["--exists", "espeak-ng"]);
  if (espeak.status !== 0) packages.push("espeak-ng");
  if (packages.length === 0) return;
  if (!commandAvailable("brew", ["--version"])) {
    throw new Error(
      `missing native build prerequisites: ${packages.join(", ")}. Install Homebrew and rerun bun install.`,
    );
  }
  run("brew", ["install", ...packages]);
}

export async function ensureFusedInferenceInstall({
  env = process.env,
  platform = process.platform,
  repoRoot = defaultRepoRoot,
  bunExecutable = process.execPath,
  run = runChecked,
  provision = true,
  findLinuxPackages = linuxPackagesMissing,
  provisionLinux = provisionLinuxPackages,
  provisionMac = provisionMacPackages,
  fetchImpl = fetch,
  ensureEmbedding = ensureEmbeddingArtifact,
} = {}) {
  if (env.ELIZA_SKIP_FUSED_INFERENCE_SETUP === "1") {
    log("skipped by ELIZA_SKIP_FUSED_INFERENCE_SETUP=1");
    return { status: "skipped" };
  }
  if (!["linux", "darwin", "win32"].includes(platform)) {
    throw new Error(
      `unsupported desktop platform for fused inference: ${platform}`,
    );
  }

  const forkPath = "plugins/plugin-local-inference/native/llama.cpp";
  run("git", ["submodule", "update", "--init", "--recursive", forkPath], {
    cwd: repoRoot,
  });

  if (provision && platform === "linux") {
    provisionLinux(findLinuxPackages(), run);
  } else if (provision && platform === "darwin") {
    provisionMac(run);
  }

  const stageScript = path.join(
    repoRoot,
    "packages/app-core/scripts/stage-desktop-fused-lib.mjs",
  );
  run(bunExecutable, [stageScript, "--ensure"], { cwd: repoRoot, env });
  const embedding = await ensureEmbedding({ env, repoRoot, fetchImpl });
  log("fused desktop inference and embedding model are installed and current");
  return { status: "ready", embedding };
}

if (import.meta.main) {
  try {
    await ensureFusedInferenceInstall();
  } catch (error) {
    console.error(`[ensure-fused-inference] ERROR: ${error.message}`);
    process.exit(1);
  }
}
