#!/usr/bin/env node
// Creates a producer-bound evidence record only after a workflow's validation
// steps have succeeded. The release assembler independently verifies every
// field and the exact subject bytes before accepting any evidence claim.
import { lstat } from "node:fs/promises";
import path from "node:path";
import { parseArgs, sha256File, writeJson } from "./os-release-lib.mjs";

const args = parseArgs(process.argv.slice(2));
const required = [
  "artifact-id",
  "source-artifact",
  "subject",
  "evidence",
  "output",
  "repository",
  "source-sha",
  "run-id",
  "run-attempt",
  "workflow",
  "job",
];
const missing = required.filter((name) => !args[name]);
if (missing.length > 0) {
  throw new Error(
    `missing required arguments: ${missing.map((name) => `--${name}`).join(", ")}`,
  );
}

const evidence = String(args.evidence)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (evidence.length === 0 || new Set(evidence).size !== evidence.length) {
  throw new Error(
    "--evidence must contain unique, nonempty evidence identifiers",
  );
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repository)) {
  throw new Error("--repository must be an owner/name GitHub repository");
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

const subject = path.resolve(args.subject);
const stats = await lstat(subject);
if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
  throw new Error("--subject must be a nonempty regular file, not a symlink");
}

await writeJson(path.resolve(args.output), {
  schemaVersion: 1,
  artifactId: args["artifact-id"],
  sourceArtifact: args["source-artifact"],
  subject: {
    filename: path.basename(subject),
    sizeBytes: stats.size,
    sha256: await sha256File(subject),
  },
  evidence,
  producer: {
    repository: args.repository,
    sourceSha: args["source-sha"],
    runId: args["run-id"],
    runAttempt: Number(args["run-attempt"]),
    workflow: args.workflow,
    job: args.job,
  },
});
