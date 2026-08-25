/**
 * Exercises tree-bound staging release certification and the production gate.
 *
 * The pure fixtures cover malformed and adversarial metadata; the CLI test
 * executes real JSON files, and the workflow assertions pin the protected job
 * graph plus the exact artifact actions.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import {
  artifactNameForTree,
  CERTIFICATION_ARTIFACT_PREFIX,
  CERTIFICATION_FILENAME,
  CERTIFICATION_SCHEMA,
  CERTIFICATION_WORKFLOW,
  createStagingReleaseCertification,
  verifyStagingReleaseCertification,
} from "./staging-release-certification.mjs";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(repoRoot, CERTIFICATION_WORKFLOW);
const workflow = readFileSync(workflowPath, "utf8").replaceAll("\r\n", "\n");
const sourceSha = "a".repeat(40);
const treeSha = "b".repeat(40);
const workflowSha256 = "c".repeat(64);
const artifactName = artifactNameForTree(treeSha);
const issuedAt = "2026-08-16T12:00:00.000Z";
const now = "2026-08-17T12:00:00.000Z";

function fixture() {
  const certification = createStagingReleaseCertification({
    repository: "elizaOS/eliza",
    runId: "12345",
    runAttempt: "2",
    sourceSha,
    treeSha,
    workflowSha256,
    artifactName,
    issuedAt,
  });
  return {
    certification,
    run: {
      id: 12345,
      run_attempt: 2,
      status: "completed",
      conclusion: "success",
      event: "push",
      head_branch: "develop",
      head_sha: sourceSha,
      path: CERTIFICATION_WORKFLOW,
      repository: { full_name: "elizaOS/eliza" },
    },
    artifact: {
      id: 67890,
      name: artifactName,
      expired: false,
      digest: `sha256:${"d".repeat(64)}`,
      workflow_run: {
        id: 12345,
        head_sha: sourceSha,
      },
    },
    expectedRepository: "elizaOS/eliza",
    expectedTreeSha: treeSha,
    expectedWorkflowSha256: workflowSha256,
    now,
  };
}

function jobBlock(source, jobId) {
  const start = source.search(new RegExp(`^  ${jobId}:\\n`, "m"));
  if (start < 0) throw new Error(`missing job ${jobId}`);
  const fromJob = source.slice(start);
  const header = `  ${jobId}:\n`;
  const next = fromJob.slice(header.length).search(/^ {2}[A-Za-z0-9_-]+:/m);
  return next < 0 ? fromJob : fromJob.slice(0, header.length + next);
}

describe("staging release certification payload", () => {
  test("accepts a different production commit when the root tree is identical", () => {
    const input = fixture();
    expect(verifyStagingReleaseCertification(input)).toEqual({
      treeSha,
      stagingSourceSha: sourceSha,
      runId: "12345",
      runAttempt: "2",
      artifactId: "67890",
      artifactDigest: `sha256:${"d".repeat(64)}`,
      expiresAt: "2026-08-30T12:00:00.000Z",
    });
  });

  test("creates the canonical schema and deterministic artifact identity", () => {
    const { certification } = fixture();
    expect(certification).toMatchObject({
      schema: CERTIFICATION_SCHEMA,
      repository: "elizaOS/eliza",
      workflow: CERTIFICATION_WORKFLOW,
      environment: "staging",
      event: "push",
      ref: "refs/heads/develop",
      source_sha: sourceSha,
      tree_sha: treeSha,
      artifact: {
        name: `${CERTIFICATION_ARTIFACT_PREFIX}${treeSha}`,
        filename: CERTIFICATION_FILENAME,
      },
    });
  });

  test("accepts an explicit canonical staging dispatch", () => {
    const input = fixture();
    input.certification = createStagingReleaseCertification({
      repository: "elizaOS/eliza",
      runId: "12345",
      runAttempt: "2",
      sourceSha,
      treeSha,
      workflowSha256,
      event: "workflow_dispatch",
      artifactName,
      issuedAt,
    });
    input.run.event = "workflow_dispatch";
    expect(verifyStagingReleaseCertification(input).treeSha).toBe(treeSha);
  });

  test.each([
    ["wrong tree", (input) => (input.expectedTreeSha = "e".repeat(40))],
    [
      "wrong repository",
      (input) => (input.expectedRepository = "attacker/fork"),
    ],
    [
      "wrong workflow bytes",
      (input) => (input.expectedWorkflowSha256 = "e".repeat(64)),
    ],
    [
      "wrong environment",
      (input) => (input.certification.environment = "production"),
    ],
    ["wrong event", (input) => (input.certification.event = "pull_request")],
    ["wrong ref", (input) => (input.certification.ref = "refs/heads/main")],
    ["expired", (input) => (input.now = "2026-08-30T12:00:00.000Z")],
    [
      "future dated",
      (input) => (input.certification.issued_at = "2026-08-18T12:00:00.000Z"),
    ],
  ])("rejects %s certificate metadata", (_label, mutate) => {
    const input = fixture();
    mutate(input);
    expect(() => verifyStagingReleaseCertification(input)).toThrow(
      /Staging release certification rejected/,
    );
  });

  test.each([
    ["failed", (run) => (run.conclusion = "failure")],
    ["incomplete", (run) => (run.status = "in_progress")],
    ["pull request", (run) => (run.event = "pull_request")],
    ["event mismatch", (run) => (run.event = "workflow_dispatch")],
    ["main", (run) => (run.head_branch = "main")],
    ["wrong workflow", (run) => (run.path = ".github/workflows/ci.yml")],
    ["wrong repository", (run) => (run.repository.full_name = "attacker/fork")],
    ["wrong source", (run) => (run.head_sha = "f".repeat(40))],
    ["wrong attempt", (run) => (run.run_attempt = 3)],
  ])("rejects an originating run that is %s", (_label, mutate) => {
    const input = fixture();
    mutate(input.run);
    expect(() => verifyStagingReleaseCertification(input)).toThrow(
      /Staging release certification rejected/,
    );
  });

  test.each([
    ["expired", (artifact) => (artifact.expired = true)],
    ["renamed", (artifact) => (artifact.name = "other")],
    ["digestless", (artifact) => (artifact.digest = "")],
    ["wrong owner", (artifact) => (artifact.workflow_run.id = 99999)],
    [
      "wrong source",
      (artifact) => (artifact.workflow_run.head_sha = "f".repeat(40)),
    ],
  ])("rejects an artifact that is %s", (_label, mutate) => {
    const input = fixture();
    mutate(input.artifact);
    expect(() => verifyStagingReleaseCertification(input)).toThrow(
      /Staging release certification rejected/,
    );
  });

  test("rejects malformed and overlong certificate lifetimes", () => {
    const input = fixture();
    input.certification.expires_at = "2026-09-30T12:00:00.000Z";
    expect(() => verifyStagingReleaseCertification(input)).toThrow(
      /lifetime exceeds policy/,
    );
    expect(() =>
      createStagingReleaseCertification({
        repository: "elizaOS/eliza",
        runId: "1",
        runAttempt: "1",
        sourceSha,
        treeSha,
        workflowSha256,
        issuedAt: "not-a-date",
      }),
    ).toThrow(/ISO timestamp/);
  });
});

describe("staging release certification CLI", () => {
  test("creates and verifies real JSON files", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "eliza-staging-cert-"));
    try {
      const localWorkflow = resolve(directory, "cloud-cf-deploy.yml");
      const certFile = resolve(directory, CERTIFICATION_FILENAME);
      const runFile = resolve(directory, "run.json");
      const artifactFile = resolve(directory, "artifact.json");
      writeFileSync(localWorkflow, "name: test-workflow\n");
      const createResult = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "staging-release-certification.mjs"),
          "create",
          "--out",
          certFile,
          "--repository",
          "elizaOS/eliza",
          "--run-id",
          "12345",
          "--run-attempt",
          "2",
          "--source-sha",
          sourceSha,
          "--tree-sha",
          treeSha,
          "--artifact-name",
          artifactName,
          "--workflow-file",
          localWorkflow,
          "--issued-at",
          issuedAt,
        ],
        { encoding: "utf8" },
      );
      expect(createResult.status).toBe(0);

      const input = fixture();
      writeFileSync(runFile, JSON.stringify(input.run));
      writeFileSync(artifactFile, JSON.stringify(input.artifact));
      const verifyResult = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, "staging-release-certification.mjs"),
          "verify",
          "--cert",
          certFile,
          "--run-json",
          runFile,
          "--artifact-json",
          artifactFile,
          "--expected-repository",
          "elizaOS/eliza",
          "--expected-tree-sha",
          treeSha,
          "--workflow-file",
          localWorkflow,
          "--now",
          now,
        ],
        { encoding: "utf8" },
      );
      expect(verifyResult.status).toBe(0);
      expect(JSON.parse(verifyResult.stdout)).toMatchObject({
        treeSha,
        runId: "12345",
        artifactId: "67890",
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("Cloud CF workflow staging certification gate", () => {
  test("emits a certificate only after a successful canonical develop release", () => {
    const block = jobBlock(workflow, "certify-staging-release");
    expect(block).toContain("needs: release");
    expect(block).toContain("github.event_name == 'push'");
    expect(block).toContain("github.event_name == 'workflow_dispatch'");
    expect(block).toContain("github.ref == 'refs/heads/develop'");
    expect(block).toContain("needs.release.result == 'success'");
    expect(block).toContain("git rev-parse 'HEAD^{tree}'");
    expect(block).toContain("staging-release-certification.mjs create");
    expect(block).toContain('--event "$GITHUB_EVENT_NAME"');
    expect(block).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    );
    expect(block).toContain("retention-days: 14");
    expect(block).toContain("steps.upload.outputs.artifact-id");
    expect(block).toContain("steps.upload.outputs.artifact-digest");
  });

  test("validates the exact production tree before environment approval", () => {
    const validate = jobBlock(workflow, "validate-staging-certification");
    const authorize = jobBlock(workflow, "authorize-production");
    const release = jobBlock(workflow, "release");
    expect(validate).not.toContain("environment: production");
    expect(validate).toContain("ref: $" + "{{ github.sha }}");
    expect(validate).toContain("persist-credentials: false");
    expect(validate).toContain("git rev-parse 'HEAD^{tree}'");
    expect(validate).toContain(
      '(.event == "push" or .event == "workflow_dispatch")',
    );
    expect(validate).toContain('head_branch == "develop"');
    expect(validate).toContain(
      'path == ".github/workflows/cloud-cf-deploy.yml"',
    );
    expect(validate).toContain(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(validate).toContain("artifact-ids:");
    expect(validate).toContain("github-token: $" + "{{ github.token }}");
    expect(validate).toContain(
      "run-id: $" + "{{ steps.resolve.outputs.staging_run_id }}",
    );
    expect(validate).toContain("digest-mismatch: error");
    expect(validate).toContain("staging-release-certification.mjs verify");
    expect(validate).not.toContain("inputs.force");
    expect(authorize).toContain("validate-staging-certification");
    expect(authorize).toContain(
      "needs.validate-staging-certification.result == 'success'",
    );
    expect(release).toContain("validate-staging-certification");
    expect(release).toContain(
      "needs.validate-staging-certification.result == 'success'",
    );
  });

  test("fails closed on absent, expired, digestless, or noncanonical artifacts", () => {
    const block = jobBlock(workflow, "validate-staging-certification");
    expect(block).toContain(
      "No unexpired successful develop Cloud certification",
    );
    expect(block).toContain("select(.expired == false)");
    expect(block).toContain('test("^sha256:[0-9a-f]{64}$")');
    expect(block).toContain('.conclusion == "success"');
    expect(block).toContain(".repository.full_name == $repo");
    expect(block).toContain("--artifact-json");
  });
});
