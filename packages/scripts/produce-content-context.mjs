#!/usr/bin/env bun
/**
 * Assembles the checked-in progressive-content evidence inventory against one
 * deterministic scale corpus, then delegates atomic publication to the
 * canonical content-context publisher. Caller-selected commands are forbidden.
 */

import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateProgressiveContentCorpus } from "../corpus-tools/src/progressive-content.ts";
import { contentContextE2EArtifactDeclarations } from "../corpus-tools/src/progressive-content-evidence.ts";
import { publishContentContextEvidence } from "./run-content-context.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const execFileAsync = promisify(execFile);
export const DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS = [
  "native-realization-ledger.json",
  "conformance.json",
  "mutant-kills.json",
  "source-work.json",
  "cleanup.json",
  "page-ledger.jsonl",
  "prompt-tokens.json",
  "faults.json",
  "stress.json",
  "scenario.json",
  "scenario-native.jsonl",
];
export const EXTERNAL_CONTENT_CONTEXT_ARTIFACTS = [
  "benchmark.json",
  "soak.json",
  "postgres.json",
  "trajectories.jsonl",
  "e2e.json",
];
export const RUN_BOUND_CONTENT_CONTEXT_ARTIFACTS = [
  ...DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS,
  ...EXTERNAL_CONTENT_CONTEXT_ARTIFACTS,
];
export const CANONICAL_DETERMINISTIC_PRODUCER = {
  command: "bun",
  args: ["packages/scripts/produce-content-context-deterministic.mjs"],
};

export function parseProductionArgs(argv) {
  const options = { profile: "scale" };
  for (const arg of argv) {
    if (arg.startsWith("--external-dir=")) options.externalDir = arg.slice(15);
    else if (arg.startsWith("--run-root=")) options.runRoot = arg.slice(11);
    else if (arg.startsWith("--commit=")) options.commit = arg.slice(9);
    else if (arg.startsWith("--profile=")) options.profile = arg.slice(10);
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ["externalDir", "runRoot"]) {
    if (!options[key])
      throw new Error(
        `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`,
      );
  }
  if (options.profile !== "scale")
    throw new Error(
      "content-context evidence requires the scale corpus profile",
    );
  return options;
}

async function readPrivateRegular(file, earliestMtime = 0) {
  const handle = await fs.open(
    file,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o077) !== 0 ||
      stat.mtimeMs < earliestMtime
    )
      throw new Error(
        `content-context artifact is stale or not a private regular file: ${path.basename(file)}`,
      );
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function assertPrivateArtifactDirectory(directory) {
  const stat = await fs.lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error(
      "content-context artifact directory must be a private real directory",
    );
  }
}

async function assertRealArtifactParents(root, relativeFile) {
  let current = root;
  for (const segment of relativeFile.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(
        `content-context artifact parent is unsafe: ${relativeFile}`,
      );
    }
  }
}

async function runCanonicalDeterministicProducer(env) {
  const entrypoint = path.join(
    REPO_ROOT,
    CANONICAL_DETERMINISTIC_PRODUCER.args[0],
  );
  try {
    await fs.access(entrypoint, fsConstants.R_OK);
  } catch (error) {
    throw new Error(
      "checked-in deterministic content-context producer is unavailable; caller-supplied evidence cannot replace it",
      { cause: error },
    );
  }
  await new Promise((resolve, reject) => {
    const child = spawn(
      CANONICAL_DETERMINISTIC_PRODUCER.command,
      CANONICAL_DETERMINISTIC_PRODUCER.args,
      {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `canonical deterministic producer failed (${signal ?? code})`,
            ),
          ),
    );
  });
}

export async function resolveProductionCommit(explicit, cwd = REPO_ROOT) {
  const commit =
    explicit ??
    (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  if (!/^[0-9a-f]{40}$/u.test(commit))
    throw new Error("content-context commit must be an exact SHA");
  return commit;
}

export async function produceContentContextEvidence(options) {
  const externalDir = path.resolve(REPO_ROOT, options.externalDir);
  await assertPrivateArtifactDirectory(externalDir);
  const commit = await resolveProductionCommit(options.commit);
  const externalBytes = new Map();
  for (const artifact of EXTERNAL_CONTENT_CONTEXT_ARTIFACTS) {
    externalBytes.set(
      artifact,
      await readPrivateRegular(path.join(externalDir, artifact)),
    );
  }
  const e2eBytes = externalBytes.get("e2e.json");
  if (!e2eBytes) throw new Error("content-context E2E report is absent");
  const referencedE2EBytes = new Map();
  for (const artifact of contentContextE2EArtifactDeclarations(e2eBytes)) {
    await assertRealArtifactParents(externalDir, artifact.path);
    referencedE2EBytes.set(
      artifact.path,
      await readPrivateRegular(
        path.join(externalDir, ...artifact.path.split("/")),
      ),
    );
  }
  const pending = await fs.mkdtemp(
    path.join(os.tmpdir(), "eliza-content-context-"),
  );
  await fs.chmod(pending, 0o700);
  try {
    const corpusRoot = path.join(pending, "corpus");
    const artifacts = path.join(pending, "artifacts");
    await fs.mkdir(artifacts, { mode: 0o700 });
    const manifest = await generateProgressiveContentCorpus({
      outDir: corpusRoot,
      profile: "scale",
      rootSeed: `content-context:${commit}`,
      generatorRevision: commit,
    });
    await fs.copyFile(
      path.join(corpusRoot, "manifest.json"),
      path.join(artifacts, "corpus-manifest.json"),
    );
    const deterministicStartedAt = Date.now() - 1_000;
    await runCanonicalDeterministicProducer({
      ELIZA_CONTENT_CONTEXT_CORPUS_ROOT: corpusRoot,
      ELIZA_CONTENT_CONTEXT_OUTPUT_DIR: artifacts,
      ELIZA_CONTENT_CONTEXT_COMMIT: commit,
      ELIZA_CONTENT_CONTEXT_MANIFEST_SHA256: manifest.manifestSha256,
    });
    for (const artifact of DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS) {
      await readPrivateRegular(
        path.join(artifacts, artifact),
        deterministicStartedAt,
      );
    }
    for (const artifact of EXTERNAL_CONTENT_CONTEXT_ARTIFACTS) {
      const bytes = externalBytes.get(artifact);
      if (!bytes)
        throw new Error(
          `run-bound content-context artifact is absent: ${artifact}`,
        );
      await fs.writeFile(path.join(artifacts, artifact), bytes, {
        flag: "wx",
        mode: 0o600,
      });
    }
    for (const [artifactPath, bytes] of referencedE2EBytes) {
      const destination = path.join(artifacts, ...artifactPath.split("/"));
      await fs.mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      await fs.writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
    }
    return await publishContentContextEvidence({
      source: artifacts,
      runRoot: options.runRoot,
      commit,
    });
  } finally {
    await fs.rm(pending, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  produceContentContextEvidence(
    parseProductionArgs(process.argv.slice(2)),
  ).then(
    (result) => console.log(JSON.stringify(result)),
    (error) => {
      console.error(error?.stack ?? String(error));
      process.exitCode = 1;
    },
  );
}
