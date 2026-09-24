/** Resolves executable Node runtimes and subprocess environments for repository test launchers. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CODEX_NODE_MARKER = `${path.sep}Applications${path.sep}Codex.app${path.sep}Contents${path.sep}Resources${path.sep}node`;

function splitPath(value) {
  return String(value || "")
    .split(path.delimiter)
    .filter(Boolean);
}

function uniqueExistingDirs(paths) {
  const seen = new Set();
  const result = [];
  for (const dir of paths) {
    if (!dir || seen.has(dir) || !fs.existsSync(dir)) {
      continue;
    }
    seen.add(dir);
    result.push(dir);
  }
  return result;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    // error-policy:J4 An unavailable executable is excluded from runtime discovery.
    return false;
  }
}

function readPinnedNodeVersion(repoRoot) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  );
  const version = manifest.engines?.node;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(
      `Expected an exact engines.node version in ${repoRoot}/package.json`,
    );
  }
  return version;
}

function nodeOptionsWithHeapLimit(value) {
  const current = String(value || "").trim();
  if (/(^|\s)--max-old-space-size=/.test(current)) {
    return current;
  }
  return [current, "--max-old-space-size=8192"].filter(Boolean).join(" ");
}

function nvmNodeCandidates(homeDir, repoRoot) {
  const version = readPinnedNodeVersion(repoRoot);
  return [
    path.join(
      homeDir,
      ".nvm",
      "versions",
      "node",
      `v${version}`,
      "bin",
      "node",
    ),
  ];
}

function pathNodeCandidates(env) {
  return splitPath(env.PATH).map((dir) => path.join(dir, "node"));
}

function canRunNode(nodePath, currentExecPath) {
  if (!nodePath || path.resolve(nodePath) === path.resolve(currentExecPath)) {
    return false;
  }
  if (!isExecutable(nodePath) || isCodexBundledNode(nodePath)) {
    return false;
  }
  const result = spawnSync(
    nodePath,
    ["-e", "process.stdout.write(`${process.platform}/${process.arch}`)"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  return (
    result.status === 0 &&
    result.stdout.trim() === `${process.platform}/${process.arch}`
  );
}

export function isCodexBundledNode(execPath = process.execPath) {
  return process.platform === "darwin" && execPath.includes(CODEX_NODE_MARKER);
}

export function resolveExternalNode({
  env = process.env,
  repoRoot = process.cwd(),
  execPath = process.execPath,
} = {}) {
  const homeDir = os.homedir();
  const candidates = [
    env.ELIZA_VITEST_NODE,
    env.ELIZA_TEST_NODE,
    ...pathNodeCandidates(env),
    ...nvmNodeCandidates(homeDir, repoRoot),
    "/opt/homebrew/bin/node",
    "/usr/local/bin/node",
  ].filter(Boolean);

  return (
    candidates.find((candidate) => canRunNode(candidate, execPath)) || null
  );
}

export function buildTestRuntimeEnv(baseEnv = process.env, options = {}) {
  const repoRoot = options.repoRoot ?? process.cwd();
  const codexNode = isCodexBundledNode(options.execPath ?? process.execPath);
  const externalNode = resolveExternalNode({
    env: baseEnv,
    repoRoot,
    execPath: options.execPath ?? process.execPath,
  });
  const homeDir = os.homedir();
  const pathPrefix = uniqueExistingDirs([
    path.join(repoRoot, "node_modules", ".bin"),
    codexNode && externalNode ? path.dirname(externalNode) : "",
    path.join(homeDir, ".bun", "bin"),
    codexNode ? "/opt/homebrew/bin" : "",
    codexNode ? "/usr/local/bin" : "",
  ]);

  return {
    ...baseEnv,
    PATH: [...pathPrefix, ...splitPath(baseEnv.PATH)].join(path.delimiter),
    NODE_OPTIONS: nodeOptionsWithHeapLimit(baseEnv.NODE_OPTIONS),
    ...(codexNode && externalNode ? { ELIZA_TEST_NODE: externalNode } : {}),
  };
}
