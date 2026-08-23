#!/usr/bin/env bun
/**
 * Validates one complete progressive-content evidence set and atomically
 * publishes it under the canonical evidence producer root. Bundle creation and
 * ingestion remain owned exclusively by test:matrix:review.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const CANONICAL_ROOT = path.join(REPO_ROOT, "reports", "content-context");
const RESULT_FILE = "content-context-result.json";
const COMPLETENESS_FILE = "completeness-manifest.json";

export function parseContentContextArgs(argv) {
  const options = { source: null, runRoot: null, commit: null };
  for (const arg of argv) {
    if (arg.startsWith("--source=")) options.source = arg.slice(9);
    else if (arg.startsWith("--run-root=")) options.runRoot = arg.slice(11);
    else if (arg.startsWith("--commit=")) options.commit = arg.slice(9);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

export function resolveContentContextPaths(options) {
  if (!options.source)
    throw new Error("--source=<artifact-directory> is required");
  if (!options.runRoot)
    throw new Error("--run-root=<assigned-run-directory> is required");
  const source = path.resolve(REPO_ROOT, options.source);
  const runRoot = path.resolve(REPO_ROOT, options.runRoot);
  if (!inside(CANONICAL_ROOT, runRoot)) {
    throw new Error(
      "content-context run root must be a child of reports/content-context",
    );
  }
  if (
    inside(source, runRoot) ||
    inside(runRoot, source) ||
    source === runRoot
  ) {
    throw new Error("content-context source and run root must not overlap");
  }
  return { source, runRoot };
}

async function readRegularFile(filePath) {
  const handle = await fs.open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new Error(
        `content-context artifact is not a private regular file: ${path.basename(filePath)}`,
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function currentCommit(explicit) {
  if (explicit) return explicit;
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(`cannot resolve exact commit: ${result.stderr}`);
  return result.stdout.trim();
}

async function canonicalParent(runRoot) {
  await fs.mkdir(CANONICAL_ROOT, { recursive: true, mode: 0o700 });
  const [realCanonical, realParent] = await Promise.all([
    fs.realpath(CANONICAL_ROOT),
    fs.realpath(path.dirname(runRoot)),
  ]);
  if (realParent !== realCanonical) {
    throw new Error(
      "content-context run root parent is not the canonical producer root",
    );
  }
  return realCanonical;
}

export async function publishContentContextEvidence(options) {
  const { source, runRoot } = resolveContentContextPaths(options);
  const commit = currentCommit(options.commit);
  if (!/^[0-9a-f]{40}$/u.test(commit))
    throw new Error("--commit must be an exact 40-character SHA");
  const sourceStat = await fs.lstat(source);
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error("content-context source must be a real directory");
  }
  const { buildContentContextResult, CONTENT_CONTEXT_REQUIRED_ARTIFACTS } =
    await import("../corpus-tools/src/progressive-content-evidence.ts");
  const artifactBytes = {};
  for (const name of CONTENT_CONTEXT_REQUIRED_ARTIFACTS) {
    artifactBytes[name] = await readRegularFile(path.join(source, name));
  }
  const corpus = JSON.parse(
    artifactBytes["corpus-manifest.json"].toString("utf8"),
  );
  const result = buildContentContextResult({
    commit,
    corpusManifestSha256: corpus.manifestSha256,
    generatorRevision: corpus.generatorRevision,
    artifactBytes,
  });
  const canonicalRoot = await canonicalParent(runRoot);
  const pending = path.join(canonicalRoot, `.pending-${randomUUID()}`);
  await fs.mkdir(pending, { mode: 0o700 });
  try {
    for (const name of CONTENT_CONTEXT_REQUIRED_ARTIFACTS) {
      await fs.writeFile(path.join(pending, name), artifactBytes[name], {
        flag: "wx",
        mode: 0o600,
      });
    }
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    await fs.writeFile(path.join(pending, RESULT_FILE), serialized, {
      flag: "wx",
      mode: 0o600,
    });
    await fs.writeFile(
      path.join(pending, COMPLETENESS_FILE),
      `${JSON.stringify(
        {
          schemaVersion: "elizaos.content-context.completeness.v1",
          commit,
          status: "passed",
          requiredArtifacts: [
            ...CONTENT_CONTEXT_REQUIRED_ARTIFACTS,
            RESULT_FILE,
          ],
          result,
        },
        null,
        2,
      )}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await fs.rename(pending, runRoot);
  } catch (error) {
    await fs.rm(pending, { recursive: true, force: true });
    throw error;
  }
  return {
    schemaVersion: 1,
    command: "content-context:publish",
    runRoot,
    result,
  };
}

function printHelp() {
  console.log(
    "Usage: bun packages/scripts/run-content-context.mjs --source=<dir> --run-root=reports/content-context/<run-id> [--commit=<sha>]",
  );
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const options = parseContentContextArgs(process.argv.slice(2));
  if (options.help) printHelp();
  else
    publishContentContextEvidence(options).then(
      (result) => console.log(JSON.stringify(result)),
      (error) => {
        console.error(error?.stack ?? String(error));
        process.exitCode = 1;
      },
    );
}
