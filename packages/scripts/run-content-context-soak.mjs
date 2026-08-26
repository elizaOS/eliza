#!/usr/bin/env bun
/** Produces private six-family soak evidence through fixed repository production targets. */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { runProgressiveContentMixedSoak } from "../core/src/testing/progressive-content-mixed-soak.ts";
import { verifyProgressiveContentCorpus } from "../corpus-tools/src/progressive-content.ts";
import { createProgressiveContentProductionSoakContract } from "./lib/progressive-content-production-targets.mjs";

export class ContentContextSoakConfigurationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ContentContextSoakConfigurationError";
    this.code = code;
  }
}

export function parseSoakArgs(argv) {
  const options = {};
  for (const arg of argv) {
    if (arg.startsWith("--corpus-root=")) options.corpusRoot = arg.slice(14);
    else if (arg.startsWith("--out=")) options.out = arg.slice(6);
    else if (arg.startsWith("--commit=")) options.commit = arg.slice(9);
    else
      throw new ContentContextSoakConfigurationError(
        "SOAK_ARGUMENT_UNSUPPORTED",
        `unsupported soak argument: ${arg}`,
      );
  }
  for (const key of ["corpusRoot", "out", "commit"]) {
    if (!options[key])
      throw new ContentContextSoakConfigurationError(
        "SOAK_ARGUMENT_REQUIRED",
        `--${key.replace(/[A-Z]/g, (value) => `-${value.toLowerCase()}`)} is required`,
      );
  }
  return options;
}

async function atomicPrivateWrite(file, bytes) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
}

export async function produceContentContextSoak(options) {
  if (!/^[0-9a-f]{40}$/u.test(options.commit))
    throw new ContentContextSoakConfigurationError(
      "SOAK_COMMIT_INVALID",
      "--commit must be a full lowercase Git SHA",
    );
  const corpusRoot = path.resolve(options.corpusRoot);
  const manifest = await verifyProgressiveContentCorpus(corpusRoot);
  const output = path.resolve(options.out);
  await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
  const workRoot = await fs.mkdtemp(
    path.join(path.dirname(output), ".content-context-soak-"),
  );
  const contract = await createProgressiveContentProductionSoakContract({
    corpusRoot,
    manifest,
    workRoot,
  });
  try {
    const report = await runProgressiveContentMixedSoak({
      commit: options.commit,
      corpusManifestSha256: manifest.manifestSha256,
      targets: contract.targets,
      measureResources: contract.measureResources,
      lifecycle: contract.lifecycle,
    });
    if (!report.evidenceEligible || report.status !== "passed")
      throw new ContentContextSoakConfigurationError(
        "SOAK_RUN_FAILED",
        `production soak did not pass: ${report.failures.join("; ")}`,
      );
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await atomicPrivateWrite(output, bytes);
    return {
      outputSha256: createHash("sha256").update(bytes).digest("hex"),
      report,
    };
  } finally {
    await contract.cleanup();
  }
}

if (import.meta.main) {
  try {
    const result = await produceContentContextSoak(
      parseSoakArgs(process.argv.slice(2)),
    );
    process.stdout.write(
      `${JSON.stringify({ outputSha256: result.outputSha256 })}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error?.code ?? "SOAK_FAILED"}: ${error?.message ?? String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
