import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

const execFileAsync = promisify(execFile);

const REPO_ROOT = new URL("../../..", import.meta.url);
const DEPLOY_SCRIPT_PATH = new URL(
  "deployment/hetzner-staging/scripts/deploy.sh",
  REPO_ROOT,
);
const RELEASE_GATE_PATH = new URL(
  "deployment/hetzner-staging/scripts/release-gate.sh",
  REPO_ROOT,
);
const RELEASE_README_PATH = new URL(
  "deployment/hetzner-staging/release/README.md",
  REPO_ROOT,
);
const RELEASE_CHECKLIST_PATH = new URL(
  "deployment/hetzner-staging/release/CHECKLIST.md",
  REPO_ROOT,
);

describe("staging deploy script contract", () => {
  it("plans the first-boot deploy path without mutating services by default", async () => {
    const result = await runDeploySmoke({ args: ["--mode", "first-boot"] });

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /dry-run complete/);

    const evidence = await readJson(result.evidencePath);
    assert.equal(evidence.mode, "first-boot");
    assert.equal(evidence.dryRun, true);
    assert.equal(evidence.status, "passed");
    assert.equal(
      evidence.files.postDeployEvidence,
      result.postDeployEvidencePath,
    );
    assert.deepEqual(stepNames(evidence), [
      "verify Forgejo image exists",
      "verify Merge Steward image exists",
      "start persistent dependencies",
      "show dependency health",
      "run merge steward migrations",
      "start merge steward",
      "run post deploy checks",
    ]);
    assert.ok(
      commandFor(evidence, "start persistent dependencies").includes(
        "up -d --wait postgres forgejo",
      ),
    );
    assert.ok(
      commandFor(evidence, "run merge steward migrations").includes(
        "up merge-steward-migrate",
      ),
    );
    assert.ok(
      commandFor(evidence, "run merge steward migrations").includes(
        "merge-steward-migrate.log",
      ),
    );
    assert.ok(
      commandFor(evidence, "run post deploy checks").includes(
        "post-deploy-check.sh",
      ),
    );
    assert.ok(
      commandFor(evidence, "run post deploy checks").includes(
        "POST_DEPLOY_EVIDENCE_OUTPUT=",
      ),
    );
  });

  it("plans the rolling deploy path with image pulls and isolated runner startup", async () => {
    const result = await runDeploySmoke({
      args: ["--mode", "rolling", "--pull", "--runner"],
    });

    assert.equal(result.code, 0, result.stderr);

    const evidence = await readJson(result.evidencePath);
    assert.equal(evidence.mode, "rolling");
    assert.equal(evidence.options.pullImages, true);
    assert.equal(evidence.options.runner, true);
    assert.ok(
      commandFor(evidence, "pull approved images").includes("docker compose"),
    );
    assert.ok(
      commandFor(evidence, "pull runner images").includes(
        "compose.actions-runner.yml",
      ),
    );
    assert.ok(
      commandFor(evidence, "verify dependency health").includes(
        "ps postgres forgejo",
      ),
    );
    assert.ok(
      commandFor(evidence, "run merge steward migrations").includes(
        "up --no-deps merge-steward-migrate",
      ),
    );
    assert.ok(
      commandFor(evidence, "restart application services").includes(
        "up -d --wait forgejo merge-steward",
      ),
    );
    assert.ok(
      commandFor(evidence, "start isolated runner stack").includes(
        "actions-dind actions-runner",
      ),
    );
  });

  it("requires an explicit valid deploy mode", async () => {
    const result = await runDeploySmoke({ args: [] });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /DEPLOY_MODE is required/);
  });

  it("keeps release docs and gate wired to the deploy orchestrator", async () => {
    const releaseGate = await readFile(RELEASE_GATE_PATH, "utf8");
    const readme = await readFile(RELEASE_README_PATH, "utf8");
    const checklist = await readFile(RELEASE_CHECKLIST_PATH, "utf8");

    assert.match(releaseGate, /scripts\/deploy\.sh/);
    assert.match(
      readme,
      /DEPLOY_MODE=first-boot deployment\/hetzner-staging\/scripts\/deploy\.sh/,
    );
    assert.match(
      readme,
      /DEPLOY_MODE=rolling deployment\/hetzner-staging\/scripts\/deploy\.sh/,
    );
    assert.match(readme, /files\.postDeployEvidence/);
    assert.match(readme, /eliza-hub-post-deploy-evidence\.json/);
    assert.match(checklist, /scripts\/deploy\.sh --mode first-boot\|rolling/);
    assert.match(checklist, /eliza-hub-deploy-evidence\.json/);
    assert.match(checklist, /eliza-hub-post-deploy-evidence\.json/);
  });
});

async function runDeploySmoke({ args = [], extraEnv = {} } = {}) {
  const dir = await mkdtempInTestRoot("deploy-script-");
  const envFile = path.join(dir, ".env");
  const artifactRoot = path.join(dir, "artifacts");
  const tmpRoot = path.join(dir, "tmp");
  const evidencePath = path.join(artifactRoot, "deploy-evidence.json");
  const migrateLogPath = path.join(artifactRoot, "merge-steward-migrate.log");
  const postDeployEvidencePath = path.join(
    artifactRoot,
    "post-deploy-evidence.json",
  );
  const binDir = path.join(dir, "bin");

  await mkdir(binDir, { recursive: true });
  await mkdir(artifactRoot, { recursive: true });
  await mkdir(tmpRoot, { recursive: true });
  await writeFile(envFile, deploySmokeEnv(), "utf8");
  await writeExecutable(path.join(binDir, "docker"), dockerMustNotRunStub());

  try {
    const result = await execFileAsync(
      "bash",
      [DEPLOY_SCRIPT_PATH.pathname, ...args],
      {
        env: {
          HOME: process.env.HOME,
          PATH: `${binDir}:${process.env.PATH}`,
          ENV_FILE: envFile,
          ELIZA_ARTIFACT_ROOT: artifactRoot,
          ELIZA_TMP_ROOT: tmpRoot,
          DEPLOY_EVIDENCE_OUTPUT: evidencePath,
          DEPLOY_MIGRATE_LOG: migrateLogPath,
          DEPLOY_POST_DEPLOY_EVIDENCE_OUTPUT: postDeployEvidencePath,
          DEPLOY_VALIDATE_ENV: "false",
          ...extraEnv,
        },
      },
    );
    return {
      code: 0,
      stdout: result.stdout,
      stderr: result.stderr,
      evidencePath,
      postDeployEvidencePath,
    };
  } catch (error) {
    return {
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      evidencePath,
      postDeployEvidencePath,
    };
  }
}

async function writeExecutable(file, body) {
  await writeFile(file, body, "utf8");
  await chmod(file, 0o755);
}

function dockerMustNotRunStub() {
  return `#!/usr/bin/env bash
set -euo pipefail
printf 'docker must not run during deploy dry-run: %s\\n' "$*" >&2
exit 2
`;
}

function deploySmokeEnv() {
  return `${[
    "FORGEJO_IMAGE=codeberg.org/forgejo/forgejo:15",
    "MERGE_STEWARD_IMAGE=registry.example.invalid/eliza/merge-steward:20260707",
    "FORGEJO_RUNNER_IMAGE=code.forgejo.org/forgejo/runner:6",
    "FORGEJO_RUNNER_DIND_IMAGE=docker:28-dind",
  ].join("\n")}\n`;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function stepNames(evidence) {
  return evidence.steps.map((step) => step.name);
}

function commandFor(evidence, name) {
  const step = evidence.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `missing deploy step: ${name}`);
  return step.command;
}
