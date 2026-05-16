#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  defaultManifestPath,
  parseArgs,
  readJson,
  repoRoot,
  validateManifest,
} from "./os-release-lib.mjs";

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));
const manifestPath = args.manifest || defaultManifestPath;
const manifest = await readJson(manifestPath);
const manifestValidation = validateManifest(manifest, {
  requirePublishableChecksums: Boolean(args["require-publishable-checksums"]),
});

const evidenceDir = path.resolve(
  args["evidence-dir"] || path.join(repoRoot, manifest.validation.evidenceDirectory),
);
await mkdir(evidenceDir, { recursive: true });

async function gitValue(commandArgs) {
  try {
    const { stdout } = await execFileAsync("git", commandArgs, { cwd: repoRoot });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readEvidenceFiles() {
  try {
    const entries = await readdir(evidenceDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const filePath = path.join(evidenceDir, entry.name);
      const text = await readFile(filePath, "utf8").catch(() => "");
      files.push({
        filename: entry.name,
        bytes: Buffer.byteLength(text),
        firstLine: text.split(/\r?\n/, 1)[0] || "",
      });
    }
    return files;
  } catch {
    return [];
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  manifestPath: path.relative(repoRoot, manifestPath),
  release: manifest.release,
  git: {
    branch: await gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: await gitValue(["rev-parse", "HEAD"]),
    statusShort: await gitValue(["status", "--short", "--", "packages/os/release", "packages/os/scripts", "packages/os/docs"]),
  },
  manifestValidation,
  artifacts: manifest.artifacts.map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    filename: artifact.filename,
    status: artifact.status,
    sha256Present: Boolean(artifact.sha256),
    sizePresent: Number.isInteger(artifact.sizeBytes),
    requiredEvidence: artifact.validation.requiredEvidence,
    collectedEvidence: artifact.validation.evidence,
  })),
  evidenceFiles: await readEvidenceFiles(),
};

const outputPath = path.resolve(args.output || path.join(evidenceDir, "release-evidence.json"));
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);

if (!manifestValidation.ok) {
  for (const error of manifestValidation.errors) {
    console.error(`error: ${error}`);
  }
  console.error(`Wrote failed evidence report to ${outputPath}`);
  process.exit(1);
}

console.log(`Wrote release evidence report to ${outputPath}`);
