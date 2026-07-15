#!/usr/bin/env node
/**
 * Validates and inventories the #11632 LifeOps workflow artifact. Both status
 * snapshots, every requested live lane, exact-run provenance, and every byte
 * included in the upload must be present before a hash manifest is written.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function requiredText(name, value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function requiredBoolean(name, value) {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be exactly true or false`);
}

function stripAnsi(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Vitest colors its summary in TTY-backed Actions logs.
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/** Parse all Vitest `Tests` summary lines from one captured lane. */
export function parseVitestCounts(logText) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  const summaryLines =
    stripAnsi(logText).match(/^[ \t]*Tests[ \t]+[^\n]*$/gm) ?? [];
  for (const line of summaryLines) {
    for (const key of Object.keys(counts)) {
      const match = new RegExp(`(\\d+)\\s+${key}`).exec(line);
      if (match) counts[key] += Number(match[1]);
    }
  }
  return { ...counts, summaryLines: summaryLines.map((line) => line.trim()) };
}

/** A live lane is proof only when tests ran and none failed or skipped. */
export function isLiveVitestProof(counts) {
  return (
    counts.summaryLines.length > 0 &&
    counts.passed > 0 &&
    counts.failed === 0 &&
    counts.skipped === 0
  );
}

function readNonempty(root, relativePath) {
  const absolute = path.join(root, relativePath);
  const bytes = readFileSync(absolute);
  if (bytes.length === 0) {
    throw new Error(`Evidence artifact is empty: ${relativePath}`);
  }
  return { absolute, bytes };
}

function readStatus(root, relativePath) {
  const { bytes } = readNonempty(root, relativePath);
  const status = JSON.parse(bytes.toString("utf8"));
  if (status.issue !== 11632 || status.verdict?.closeable !== false) {
    throw new Error(
      `${relativePath} has the wrong issue or fabricated a closeable verdict`,
    );
  }
  return status;
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && entry.name !== "artifact-manifest.json") {
        files.push(absolute);
      }
    }
  };
  visit(root);
  return files.sort();
}

/** Validate the artifact tree and write its exact-byte manifest. */
export function validate11632Evidence({
  root,
  requestedMatrix,
  requestedConnectors,
  commit,
  runId,
  runAttempt,
}) {
  const evidenceRoot = path.resolve(requiredText("root", root));
  const provenance = {
    commit: requiredText("commit", commit),
    runId: requiredText("runId", runId),
    runAttempt: requiredText("runAttempt", runAttempt),
  };

  for (const relativePath of ["pre/README.md", "post/README.md"]) {
    readNonempty(evidenceRoot, relativePath);
  }
  const preStatus = readStatus(evidenceRoot, "pre/status.json");
  const postStatus = readStatus(evidenceRoot, "post/status.json");

  let matrixCounts = null;
  if (requestedMatrix) {
    const matrix = readNonempty(
      evidenceRoot,
      "owner-agent-permission-matrix.txt",
    ).bytes.toString("utf8");
    matrixCounts = parseVitestCounts(matrix);
    if (
      matrixCounts.passed !== 20 ||
      matrixCounts.failed !== 0 ||
      matrixCounts.skipped !== 0
    ) {
      throw new Error(
        "OWNER/AGENT matrix artifact does not prove exactly 20 passing tests",
      );
    }
  }

  const connectorCounts = {};
  for (const filename of requestedConnectors
    ? ["plugin-google-live.txt", "plugin-x-live.txt"]
    : []) {
    const log = readNonempty(evidenceRoot, filename).bytes.toString("utf8");
    const counts = parseVitestCounts(log);
    if (!isLiveVitestProof(counts)) {
      throw new Error(
        `Requested connector artifact is not skip-free live proof: ${filename}`,
      );
    }
    connectorCounts[filename] = counts;
  }

  const artifacts = listFiles(evidenceRoot).map((absolute) => {
    const bytes = readFileSync(absolute);
    if (bytes.length === 0) {
      throw new Error(
        `Evidence artifact is empty: ${path.relative(evidenceRoot, absolute)}`,
      );
    }
    return {
      path: path.relative(evidenceRoot, absolute).split(path.sep).join("/"),
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  });

  const manifest = {
    schema: "eliza_lifeops_11632_evidence_v1",
    issue: 11632,
    ...provenance,
    requestedMatrix,
    requestedConnectors,
    proof: {
      matrix: matrixCounts,
      connectors: connectorCounts,
      preGeneratedAt: preStatus.generatedAt,
      postGeneratedAt: postStatus.generatedAt,
      closeable: false,
    },
    artifacts,
  };
  writeFileSync(
    path.join(evidenceRoot, "artifact-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/** Validate the workflow contract directly from an Actions-style environment. */
export function validate11632EvidenceFromEnv(env) {
  return validate11632Evidence({
    root: env.LIFEOPS_EVIDENCE_DIR,
    requestedMatrix: requiredBoolean(
      "RUN_KEYLESS_MATRIX",
      env.RUN_KEYLESS_MATRIX,
    ),
    requestedConnectors: requiredBoolean(
      "RUN_LIVE_CONNECTORS",
      env.RUN_LIVE_CONNECTORS,
    ),
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  });
}

const IS_MAIN =
  import.meta.main || process.argv[1] === fileURLToPath(import.meta.url);

if (IS_MAIN) {
  const manifest = validate11632EvidenceFromEnv(process.env);
  console.log(
    `[11632-evidence] validated ${manifest.artifacts.length} artifact(s) for ${manifest.commit}`,
  );
}
