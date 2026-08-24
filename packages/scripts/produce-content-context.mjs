#!/usr/bin/env bun
/**
 * Orchestrates one deterministic progressive-content corpus through named
 * production subproducers, then delegates publication to the canonical
 * content-context publisher. Live, soak, Postgres, and browser evidence are
 * imported only as fresh run-bound artifacts and are never synthesized here.
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
import { publishContentContextEvidence } from "./run-content-context.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "../..");
const execFileAsync = promisify(execFile);
export const DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS = [
  "native-realization-ledger.json",
  "conformance.json",
  "mutant-kills.json",
  "source-work.json",
  "benchmark.json",
  "cleanup.json",
  "page-ledger.jsonl",
  "prompt-tokens.json",
  "faults.json",
  "stress.json",
  "scenario.json",
  "scenario-native.jsonl",
];
export const EXTERNAL_CONTENT_CONTEXT_ARTIFACTS = [
  "soak.json",
  "postgres.json",
  "trajectories.jsonl",
  "e2e.json",
];

export function parseProductionArgs(argv) {
  const options = { profile: "scale" };
  for (const arg of argv) {
    if (arg.startsWith("--plan=")) options.plan = arg.slice(7);
    else if (arg.startsWith("--external-dir="))
      options.externalDir = arg.slice(15);
    else if (arg.startsWith("--run-root=")) options.runRoot = arg.slice(11);
    else if (arg.startsWith("--commit=")) options.commit = arg.slice(9);
    else if (arg.startsWith("--profile=")) options.profile = arg.slice(10);
    else throw new Error(`unknown argument: ${arg}`);
  }
  for (const key of ["plan", "externalDir", "runRoot"]) {
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

export function validateProductionPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("content-context producer plan must be an object");
  if (value.schemaVersion !== "elizaos.content-context.producers.v1")
    throw new Error("content-context producer plan schema is unsupported");
  if (!Array.isArray(value.producers))
    throw new Error("content-context producer plan requires producers");
  const byArtifact = new Map();
  for (const producer of value.producers) {
    if (!producer || typeof producer !== "object" || Array.isArray(producer))
      throw new Error("content-context producer declaration is invalid");
    if (
      !DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS.includes(producer.artifact) ||
      byArtifact.has(producer.artifact) ||
      typeof producer.command !== "string" ||
      !producer.command ||
      !Array.isArray(producer.args) ||
      producer.args.some((arg) => typeof arg !== "string")
    )
      throw new Error(
        "content-context producer declaration is invalid or duplicated",
      );
    byArtifact.set(producer.artifact, producer);
  }
  const missing = DETERMINISTIC_CONTENT_CONTEXT_ARTIFACTS.filter(
    (artifact) => !byArtifact.has(artifact),
  );
  if (missing.length)
    throw new Error(`missing deterministic subproducers: ${missing.join(",")}`);
  return [...byArtifact.values()];
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

async function runChild(producer, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(producer.command, producer.args, {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `subproducer ${producer.artifact} failed (${signal ?? code})`,
            ),
          ),
    );
  });
}

export async function produceContentContextEvidence(options) {
  const planPath = path.resolve(REPO_ROOT, options.plan);
  const externalDir = path.resolve(REPO_ROOT, options.externalDir);
  const plan = validateProductionPlan(
    JSON.parse(await fs.readFile(planPath, "utf8")),
  );
  const commit =
    options.commit ??
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT }).then(
      ({ stdout }) => stdout.trim(),
    );
  if (!/^[0-9a-f]{40}$/u.test(commit))
    throw new Error("content-context commit must be an exact SHA");
  const externalBytes = new Map();
  for (const artifact of EXTERNAL_CONTENT_CONTEXT_ARTIFACTS) {
    externalBytes.set(
      artifact,
      await readPrivateRegular(path.join(externalDir, artifact)),
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
    for (const producer of plan) {
      const output = path.join(artifacts, producer.artifact);
      const startedAt = Date.now() - 1_000;
      await runChild(producer, {
        ELIZA_CONTENT_CONTEXT_CORPUS_ROOT: corpusRoot,
        ELIZA_CONTENT_CONTEXT_OUTPUT: output,
        ELIZA_CONTENT_CONTEXT_COMMIT: commit,
        ELIZA_CONTENT_CONTEXT_MANIFEST_SHA256: manifest.manifestSha256,
      });
      await readPrivateRegular(output, startedAt);
    }
    for (const artifact of EXTERNAL_CONTENT_CONTEXT_ARTIFACTS) {
      const bytes = externalBytes.get(artifact);
      if (!bytes)
        throw new Error(
          `external content-context artifact is absent: ${artifact}`,
        );
      await fs.writeFile(path.join(artifacts, artifact), bytes, {
        flag: "wx",
        mode: 0o600,
      });
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
