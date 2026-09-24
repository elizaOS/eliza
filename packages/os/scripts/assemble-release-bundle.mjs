#!/usr/bin/env node
// Binds GitHub Actions artifacts to one canonical, manifest-verified release bundle.
import { copyFile, lstat, mkdir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  parseArgs,
  readJson,
  sha256File,
  validateManifest,
  writeJson,
} from "./os-release-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const required = [
  "manifest",
  "artifact-root",
  "output",
  "manifest-output",
  "repository",
  "tag",
  "source-sha",
  "run-id",
  "run-attempt",
];
const missing = required.filter((name) => !args[name]);
if (missing.length > 0) {
  throw new Error(
    `missing required arguments: ${missing.map((name) => `--${name}`).join(", ")}`,
  );
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repository)) {
  throw new Error("--repository must be an owner/name GitHub repository");
}
if (!/^v[0-9]+\.[0-9]+\.[0-9]+(?:[.+-][0-9A-Za-z.-]+)?$/.test(args.tag)) {
  throw new Error("--tag must be a versioned release tag");
}
if (
  args["available-date"] &&
  !/^\d{4}-\d{2}-\d{2}$/.test(args["available-date"])
) {
  throw new Error("--available-date must use YYYY-MM-DD");
}
if (!/^[a-f0-9]{40}$/.test(args["source-sha"])) {
  throw new Error("--source-sha must be a lowercase 40-character Git commit");
}
if (!/^[1-9][0-9]*$/.test(args["run-id"])) {
  throw new Error("--run-id must be a positive integer");
}
if (!/^[1-9][0-9]*$/.test(args["run-attempt"])) {
  throw new Error("--run-attempt must be a positive integer");
}

const manifest = await readJson(path.resolve(args.manifest));
if (args.evidence) {
  throw new Error(
    "--evidence is forbidden; evidence must come from producer-bound records",
  );
}
const validation = validateManifest(manifest);
if (!validation.ok) {
  throw new Error(
    `candidate manifest is invalid:\n${validation.errors.join("\n")}`,
  );
}
if (manifest.schemaVersion !== 2) {
  throw new Error("release bundle assembly requires schemaVersion 2");
}
if (`v${manifest.release.version}` !== args.tag) {
  throw new Error(
    `manifest version ${manifest.release.version} does not match tag ${args.tag}`,
  );
}

const artifactRoot = path.resolve(args["artifact-root"]);
const outputRoot = path.resolve(args.output);
const artifactRootReal = await realpath(artifactRoot);
await mkdir(outputRoot, { recursive: true });

function basenamePattern(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`);
}

async function walkRegularFiles(directory, root = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(
        `release input contains a symlink: ${path.relative(root, candidate)}`,
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await walkRegularFiles(candidate, root)));
    } else if (entry.isFile()) {
      files.push(candidate);
    }
  }
  return files;
}

function validateEvidenceRecord(record, artifact, subject) {
  const errors = [];
  if (record?.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (record?.artifactId !== artifact.id) errors.push("artifactId mismatch");
  if (record?.sourceArtifact !== artifact.source.artifact) {
    errors.push("sourceArtifact mismatch");
  }
  if (record?.subject?.filename !== path.basename(subject.path)) {
    errors.push("subject filename mismatch");
  }
  if (record?.subject?.sizeBytes !== subject.sizeBytes) {
    errors.push("subject size mismatch");
  }
  if (record?.subject?.sha256 !== subject.sha256) {
    errors.push("subject SHA-256 mismatch");
  }
  if (
    !Array.isArray(record?.evidence) ||
    record.evidence.length === 0 ||
    record.evidence.some(
      (value) => typeof value !== "string" || value.length === 0,
    ) ||
    new Set(record.evidence).size !== record.evidence.length
  ) {
    errors.push("evidence must contain unique, nonempty identifiers");
  }
  if (record?.producer?.repository !== args.repository) {
    errors.push("producer repository mismatch");
  }
  if (record?.producer?.sourceSha !== args["source-sha"]) {
    errors.push("producer source SHA mismatch");
  }
  if (record?.producer?.runId !== args["run-id"]) {
    errors.push("producer run ID mismatch");
  }
  if (record?.producer?.runAttempt !== Number(args["run-attempt"])) {
    errors.push("producer run attempt mismatch");
  }
  for (const field of ["workflow", "job"]) {
    if (
      typeof record?.producer?.[field] !== "string" ||
      record.producer[field].length === 0
    ) {
      errors.push(`producer ${field} must be a nonempty string`);
    }
  }
  return errors;
}

for (const artifact of manifest.artifacts) {
  if (artifact.status === "withdrawn" || artifact.kind === "checksum-manifest")
    continue;
  const sourceRoot = path.resolve(artifactRoot, artifact.source.artifact);
  const sourceRootReal = await realpath(sourceRoot);
  if (!sourceRootReal.startsWith(`${artifactRootReal}${path.sep}`)) {
    throw new Error(
      `artifact source escapes download root: ${artifact.source.artifact}`,
    );
  }
  const matcher = basenamePattern(artifact.source.pattern);
  const matches = (await walkRegularFiles(sourceRootReal)).filter((file) =>
    matcher.test(path.basename(file)),
  );
  if (matches.length !== 1) {
    throw new Error(
      `${artifact.id} requires exactly one ${artifact.source.pattern} in ${artifact.source.artifact}; found ${matches.length}`,
    );
  }
  const sourceStats = await lstat(matches[0]);
  if (!sourceStats.isFile() || sourceStats.size === 0) {
    throw new Error(`${artifact.id} source is not a nonempty regular file`);
  }
  const destination = path.join(outputRoot, artifact.filename);
  await copyFile(matches[0], destination);
  const destinationStats = await lstat(destination);
  artifact.sizeBytes = destinationStats.size;
  artifact.sha256 = await sha256File(destination);
  artifact.downloadUrl = `https://github.com/${args.repository}/releases/download/${args.tag}/${encodeURIComponent(artifact.filename)}`;
  artifact.status = "published";
  const evidenceFiles = (await walkRegularFiles(sourceRootReal)).filter(
    (file) => file.endsWith(".release-evidence.json"),
  );
  const evidenceRecords = [];
  for (const evidenceFile of evidenceFiles) {
    const record = await readJson(evidenceFile);
    if (record?.artifactId === artifact.id) evidenceRecords.push(record);
  }
  if (evidenceRecords.length !== 1) {
    throw new Error(
      `${artifact.id} requires exactly one producer evidence record; found ${evidenceRecords.length}`,
    );
  }
  const record = evidenceRecords[0];
  const recordErrors = validateEvidenceRecord(record, artifact, {
    path: matches[0],
    sizeBytes: artifact.sizeBytes,
    sha256: artifact.sha256,
  });
  if (recordErrors.length > 0) {
    throw new Error(
      `${artifact.id} producer evidence record is invalid:\n${recordErrors.join("\n")}`,
    );
  }
  const confirmedEvidence = new Set(record.evidence);
  for (const requiredEvidence of artifact.validation.requiredEvidence) {
    if (
      !["ci-artifact-bound", "sha256-generated"].includes(requiredEvidence) &&
      !confirmedEvidence.has(requiredEvidence)
    ) {
      throw new Error(
        `${artifact.id} is missing confirmed evidence ${requiredEvidence}`,
      );
    }
  }
  artifact.validation.evidence = [
    ...new Set([
      ...(artifact.validation.evidence ?? []),
      ...artifact.validation.requiredEvidence.filter((evidence) =>
        confirmedEvidence.has(evidence),
      ),
      "ci-artifact-bound",
      "sha256-generated",
      ...(artifact.target.platform === "macos" &&
      confirmedEvidence.has("apple-notarization")
        ? ["apple-notarization"]
        : []),
      ...(artifact.target.platform === "windows" &&
      confirmedEvidence.has("authenticode")
        ? ["authenticode"]
        : []),
    ]),
  ];
}

manifest.release.status = "available";
if (args["available-date"]) {
  manifest.release.availableDate = args["available-date"];
}
const publishable = validateManifest(manifest, {
  requirePublishableChecksums: true,
});
if (!publishable.ok) {
  throw new Error(
    `assembled manifest is not publishable:\n${publishable.errors.join("\n")}`,
  );
}
await writeJson(path.resolve(args["manifest-output"]), manifest);
