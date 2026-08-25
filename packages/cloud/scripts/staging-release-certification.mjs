/**
 * Creates and verifies GitHub-bound staging release certifications.
 *
 * The certificate binds a successful develop release to its Git tree rather
 * than its commit SHA so a byte-identical main promotion can be admitted. The
 * verifier also requires the immutable GitHub artifact and originating run
 * metadata; the JSON payload alone is never an authority.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CERTIFICATION_SCHEMA =
  "eliza.cloud.staging-release-certification/v1";
export const CERTIFICATION_WORKFLOW = ".github/workflows/cloud-cf-deploy.yml";
export const CERTIFICATION_ENVIRONMENT = "staging";
export const CERTIFICATION_EVENTS = ["push", "workflow_dispatch"];
export const CERTIFICATION_REF = "refs/heads/develop";
export const CERTIFICATION_ARTIFACT_PREFIX = "cloud-staging-certification-v1-";
export const CERTIFICATION_FILENAME = "staging-cloud-certification.json";
export const CERTIFICATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ARTIFACT_DIGEST = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function fail(message) {
  throw new Error(`Staging release certification rejected: ${message}`);
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label, pattern) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  if (pattern && !pattern.test(value)) {
    fail(`${label} has an invalid format`);
  }
  return value;
}

function requirePositiveIntegerString(value, label) {
  const normalized = String(value ?? "");
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    fail(`${label} must be a positive integer`);
  }
  return normalized;
}

function parseTimestamp(value, label) {
  requireString(value, label);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    fail(`${label} must be an ISO timestamp`);
  }
  return timestamp;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function sha256File(path) {
  return sha256(readFileSync(path));
}

export function artifactNameForTree(treeSha) {
  requireString(treeSha, "tree SHA", SHA40);
  return `${CERTIFICATION_ARTIFACT_PREFIX}${treeSha}`;
}

export function createStagingReleaseCertification({
  repository,
  runId,
  runAttempt,
  sourceSha,
  treeSha,
  workflowSha256,
  event = "push",
  artifactName = artifactNameForTree(treeSha),
  issuedAt = new Date().toISOString(),
  expiresAt,
}) {
  requireString(repository, "repository", REPOSITORY);
  requirePositiveIntegerString(runId, "run id");
  requirePositiveIntegerString(runAttempt, "run attempt");
  requireString(sourceSha, "source SHA", SHA40);
  requireString(treeSha, "tree SHA", SHA40);
  requireString(workflowSha256, "workflow SHA-256", SHA256);
  requireString(event, "event");
  if (!CERTIFICATION_EVENTS.includes(event)) {
    fail("event is not an admitted staging release trigger");
  }
  if (artifactName !== artifactNameForTree(treeSha)) {
    fail("artifact name does not bind the certified tree");
  }
  const issued = parseTimestamp(issuedAt, "issued_at");
  const resolvedExpiresAt =
    expiresAt ?? new Date(issued + CERTIFICATION_TTL_MS).toISOString();
  const expires = parseTimestamp(resolvedExpiresAt, "expires_at");
  if (expires <= issued || expires - issued > CERTIFICATION_TTL_MS) {
    fail("certificate lifetime must be positive and at most 14 days");
  }

  return {
    schema: CERTIFICATION_SCHEMA,
    repository,
    workflow: CERTIFICATION_WORKFLOW,
    workflow_sha256: workflowSha256,
    environment: CERTIFICATION_ENVIRONMENT,
    event,
    ref: CERTIFICATION_REF,
    run_id: String(runId),
    run_attempt: String(runAttempt),
    source_sha: sourceSha,
    tree_sha: treeSha,
    artifact: {
      name: artifactName,
      filename: CERTIFICATION_FILENAME,
    },
    issued_at: new Date(issued).toISOString(),
    expires_at: new Date(expires).toISOString(),
  };
}

export function verifyStagingReleaseCertification({
  certification,
  run,
  artifact,
  expectedRepository,
  expectedTreeSha,
  expectedWorkflowSha256,
  now = new Date().toISOString(),
}) {
  const cert = requireRecord(certification, "certificate");
  const runMetadata = requireRecord(run, "originating run metadata");
  const artifactMetadata = requireRecord(artifact, "artifact metadata");

  requireString(expectedRepository, "expected repository", REPOSITORY);
  requireString(expectedTreeSha, "expected tree SHA", SHA40);
  requireString(expectedWorkflowSha256, "expected workflow SHA-256", SHA256);

  if (cert.schema !== CERTIFICATION_SCHEMA) fail("schema is unsupported");
  if (cert.repository !== expectedRepository) fail("repository does not match");
  if (cert.workflow !== CERTIFICATION_WORKFLOW) fail("workflow does not match");
  if (cert.workflow_sha256 !== expectedWorkflowSha256) {
    fail("workflow bytes do not match the promoted tree");
  }
  if (cert.environment !== CERTIFICATION_ENVIRONMENT) {
    fail("environment is not staging");
  }
  if (
    !CERTIFICATION_EVENTS.includes(cert.event) ||
    cert.ref !== CERTIFICATION_REF
  ) {
    fail("certificate is not from an admitted develop release");
  }
  requireString(cert.source_sha, "certificate source SHA", SHA40);
  requireString(cert.tree_sha, "certificate tree SHA", SHA40);
  if (cert.tree_sha !== expectedTreeSha)
    fail("Git tree does not match production");

  const expectedArtifactName = artifactNameForTree(expectedTreeSha);
  const certArtifact = requireRecord(cert.artifact, "certificate artifact");
  if (
    certArtifact.name !== expectedArtifactName ||
    certArtifact.filename !== CERTIFICATION_FILENAME
  ) {
    fail("certificate artifact identity does not match");
  }

  const issued = parseTimestamp(cert.issued_at, "issued_at");
  const expires = parseTimestamp(cert.expires_at, "expires_at");
  const current = parseTimestamp(now, "verification time");
  if (issued > current + CLOCK_SKEW_MS) fail("certificate is future-dated");
  if (expires <= issued || expires - issued > CERTIFICATION_TTL_MS) {
    fail("certificate lifetime exceeds policy");
  }
  if (current >= expires) fail("certificate has expired");

  const runId = requirePositiveIntegerString(cert.run_id, "certificate run id");
  const runAttempt = requirePositiveIntegerString(
    cert.run_attempt,
    "certificate run attempt",
  );
  if (String(runMetadata.id) !== runId)
    fail("originating run id does not match");
  if (String(runMetadata.run_attempt) !== runAttempt) {
    fail("originating run attempt does not match");
  }
  if (
    runMetadata.status !== "completed" ||
    runMetadata.conclusion !== "success"
  ) {
    fail("originating run did not complete successfully");
  }
  if (
    !CERTIFICATION_EVENTS.includes(runMetadata.event) ||
    runMetadata.event !== cert.event ||
    runMetadata.head_branch !== "develop" ||
    runMetadata.path !== CERTIFICATION_WORKFLOW
  ) {
    fail("originating run is not the canonical develop Cloud workflow");
  }
  const runRepository = requireRecord(
    runMetadata.repository,
    "originating run repository",
  );
  if (runRepository.full_name !== expectedRepository) {
    fail("originating run repository does not match");
  }
  if (runMetadata.head_sha !== cert.source_sha) {
    fail("originating run source SHA does not match");
  }

  const artifactId = requirePositiveIntegerString(
    artifactMetadata.id,
    "artifact id",
  );
  if (
    artifactMetadata.name !== expectedArtifactName ||
    artifactMetadata.expired !== false
  ) {
    fail("artifact name or expiry state does not match");
  }
  requireString(artifactMetadata.digest, "artifact digest", ARTIFACT_DIGEST);
  const workflowRun = requireRecord(
    artifactMetadata.workflow_run,
    "artifact workflow_run",
  );
  if (String(workflowRun.id) !== runId) {
    fail("artifact is not owned by the certified run");
  }
  if (workflowRun.head_sha && workflowRun.head_sha !== cert.source_sha) {
    fail("artifact source SHA does not match");
  }

  return {
    treeSha: cert.tree_sha,
    stagingSourceSha: cert.source_sha,
    runId,
    runAttempt,
    artifactId,
    artifactDigest: artifactMetadata.digest,
    expiresAt: cert.expires_at,
  };
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) fail(`unexpected argument ${token}`);
    const equal = token.indexOf("=");
    if (equal > 2) {
      values[token.slice(2, equal)] = token.slice(equal + 1);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`missing value for --${key}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    // error-policy:J1 CLI input failures become one structured process error.
    fail(`${label} is not valid JSON (${error.message})`);
  }
}

function runCli(argv) {
  const [command, ...rest] = argv;
  const args = parseArguments(rest);
  if (command === "create") {
    const workflowFile = requireString(args["workflow-file"], "workflow file");
    const certification = createStagingReleaseCertification({
      repository: args.repository,
      runId: args["run-id"],
      runAttempt: args["run-attempt"],
      sourceSha: args["source-sha"],
      treeSha: args["tree-sha"],
      workflowSha256: sha256File(workflowFile),
      event: args.event ?? "push",
      artifactName: args["artifact-name"],
      issuedAt: args["issued-at"] ?? new Date().toISOString(),
    });
    const output = requireString(args.out, "output path");
    writeFileSync(output, `${JSON.stringify(certification, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        schema: certification.schema,
        tree_sha: certification.tree_sha,
        artifact_name: certification.artifact.name,
        expires_at: certification.expires_at,
      }),
    );
    return;
  }

  if (command === "verify") {
    const workflowFile = requireString(args["workflow-file"], "workflow file");
    const result = verifyStagingReleaseCertification({
      certification: readJson(args.cert, "certificate"),
      run: readJson(args["run-json"], "run metadata"),
      artifact: readJson(args["artifact-json"], "artifact metadata"),
      expectedRepository: args["expected-repository"],
      expectedTreeSha: args["expected-tree-sha"],
      expectedWorkflowSha256: sha256File(workflowFile),
      now: args.now ?? new Date().toISOString(),
    });
    console.log(JSON.stringify(result));
    return;
  }

  fail("command must be create or verify");
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    // error-policy:J1 The process boundary owns the stable nonzero CLI result.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
