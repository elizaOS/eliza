#!/usr/bin/env node
/**
 * Binds a local-inference report to executable and model bytes from one host.
 * The manifest records cryptographic identities and refuses a mismatched model,
 * non-executable binary, incompatible report host, or zero successful variants.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value)
      throw new Error(`missing value for ${key ?? "argument"}`);
    args[key.slice(2)] = value;
  }
  for (const key of [
    "binary",
    "model",
    "report",
    "backend",
    "expected-model-sha256",
    "source-sha",
    "workflow-sha",
    "out",
  ]) {
    if (!args[key]) throw new Error(`--${key} is required`);
  }
  return args;
}

async function sha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function attest(args) {
  const binary = path.resolve(args.binary);
  const model = path.resolve(args.model);
  const reportPath = path.resolve(args.report);
  const binaryStat = statSync(binary);
  if (!binaryStat.isFile() || (binaryStat.mode & 0o111) === 0)
    throw new Error("binary is not an executable file");
  const probe = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (probe.error || probe.status !== 0)
    throw new Error(
      `binary is not host-executable: ${probe.error?.message ?? `exit ${probe.status}`}`,
    );
  const modelSha256 = await sha256(model);
  if (modelSha256 !== args["expected-model-sha256"])
    throw new Error(`model SHA-256 mismatch: ${modelSha256}`);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (
    report?.hardware?.platform !== process.platform ||
    report?.hardware?.arch !== process.arch
  ) {
    throw new Error("report host does not match attesting host");
  }
  if (report?.hardware?.backend !== args.backend)
    throw new Error("report backend does not match attestation");
  const executedVariants =
    report.variants?.filter((row) => row.ok === true && row.skipped !== true)
      .length ?? 0;
  if (executedVariants < 1)
    throw new Error("report contains zero successful variants");
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    workflowSha: args["workflow-sha"],
    sourceSha: args["source-sha"],
    host: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      backend: args.backend,
    },
    binary: {
      path: binary,
      bytes: binaryStat.size,
      sha256: await sha256(binary),
      version: `${probe.stdout ?? ""}\n${probe.stderr ?? ""}`
        .trim()
        .split(/\r?\n/)[0],
    },
    model: { path: model, bytes: statSync(model).size, sha256: modelSha256 },
    report: {
      path: reportPath,
      bytes: statSync(reportPath).size,
      sha256: await sha256(reportPath),
      executedVariants,
    },
  };
  writeFileSync(args.out, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (import.meta.main) {
  try {
    await attest(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(
      `[local-inference-attest] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
