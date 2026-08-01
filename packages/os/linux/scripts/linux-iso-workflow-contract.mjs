#!/usr/bin/env node
/**
 * Enforces the release contract for the canonical elizaOS Live workflow.
 * Parsed workflow checks keep APT preflight, amd64-only publication, real
 * firmware boot, provenance, and complete artifacts fail-closed as CI evolves.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseDocument } from "yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const WORKFLOW_PATH = ".github/workflows/build-linux-iso.yml";
const VALIDATION_WORKFLOW_PATH = ".github/workflows/elizaos-os-release.yml";
const IMMUTABLE_ACTION_REF = /^[^@]+@[0-9a-f]{40}$/;
const SUCCESS_FORCING_SHELL = /(?:\|\|\s*true\b|;\s*true\b|set\s+\+e\b)/;
const ISO_PATH_EXPRESSION = `\${{ steps.iso.outputs.path }}`;
const ISO_FILENAME_EXPRESSION = `\${{ steps.iso.outputs.filename }}`;
const SBOM_ROOT_EXPRESSION = `\${{ steps.sbom-extract.outputs.root }}`;
const LINUX_DIR_EXPRESSION = `\${{ env.LINUX_DIR }}`;

function workflowInvariant(workflowPath, condition, message) {
  if (!condition) {
    throw new Error(`${workflowPath}: ${message}`);
  }
}

function invariant(condition, message) {
  workflowInvariant(WORKFLOW_PATH, condition, message);
}

function parseWorkflowSource(source, workflowPath) {
  const document = parseDocument(source, {
    maxAliasCount: 0,
    prettyErrors: true,
    schema: "core",
    uniqueKeys: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `${workflowPath}: invalid YAML: ${document.errors
        .map((error) => error.message)
        .join("; ")}`,
    );
  }

  const workflow = document.toJS({ maxAliasCount: 0 });
  workflowInvariant(
    workflowPath,
    workflow && typeof workflow === "object" && !Array.isArray(workflow),
    "workflow root must be a mapping",
  );
  return workflow;
}

export function parseLinuxIsoWorkflow(source) {
  return parseWorkflowSource(source, WORKFLOW_PATH);
}

function requireBuildJob(workflow) {
  invariant(
    workflow.jobs &&
      typeof workflow.jobs === "object" &&
      !Array.isArray(workflow.jobs),
    "jobs must be a mapping",
  );
  const job = workflow.jobs["build-iso"];
  invariant(job && typeof job === "object", "missing jobs.build-iso");
  invariant(
    Array.isArray(job.steps) && job.steps.length > 0,
    "jobs.build-iso must contain steps",
  );
  invariant(job.if === undefined, "jobs.build-iso may not be conditional");
  invariant(
    job["continue-on-error"] !== true,
    "jobs.build-iso may not continue on error",
  );
  return job;
}

function requireRunStep(job, fragment, description) {
  const index = job.steps.findIndex(
    (step) => typeof step?.run === "string" && step.run.includes(fragment),
  );
  invariant(index >= 0, `missing ${description} step`);
  return { index, step: job.steps[index] };
}

function requireActionStep(job, action, description) {
  const index = job.steps.findIndex(
    (step) =>
      typeof step?.uses === "string" && step.uses.startsWith(`${action}@`),
  );
  invariant(index >= 0, `missing ${description} step`);
  return { index, step: job.steps[index] };
}

function requireFailClosed(step, description) {
  invariant(step.if === undefined, `${description} may not be conditional`);
  invariant(
    step["continue-on-error"] !== true,
    `${description} may not continue on error`,
  );
  invariant(
    typeof step.run === "string" && step.run.includes("set -euo pipefail"),
    `${description} must use strict shell mode`,
  );
  invariant(
    !SUCCESS_FORCING_SHELL.test(step.run),
    `${description} contains a success-forcing shell construct`,
  );
}

function requireOrdered(before, after, description) {
  invariant(before.index < after.index, description);
}

function requireArtifactMembers(step, description) {
  const members = String(step.with?.path ?? step.with?.files ?? "");
  for (const member of [
    ISO_PATH_EXPRESSION,
    `${ISO_FILENAME_EXPRESSION}.sha256`,
    `${ISO_FILENAME_EXPRESSION}.spdx.json`,
  ]) {
    invariant(
      members.includes(member),
      `${description} must include ${member}`,
    );
  }
}

export function validateLinuxIsoWorkflow(workflow) {
  const job = requireBuildJob(workflow);
  invariant(
    job.env?.ELIZAOS_ARCH === "amd64",
    "jobs.build-iso must publish only the canonical amd64 architecture",
  );
  invariant(
    job.strategy?.matrix === undefined,
    "jobs.build-iso may not advertise an architecture matrix",
  );
  invariant(
    job.env?.LINUX_DIR === "packages/os/linux",
    "jobs.build-iso must build the canonical Linux source tree",
  );
  invariant(
    job["timeout-minutes"] === 300,
    "jobs.build-iso must retain a bounded timeout",
  );
  invariant(
    job.permissions?.["id-token"] === "write" &&
      job.permissions?.attestations === "write",
    "jobs.build-iso must retain OIDC attestation permissions",
  );

  for (const step of job.steps) {
    if (typeof step?.uses === "string" && !step.uses.startsWith("./")) {
      invariant(
        IMMUTABLE_ACTION_REF.test(step.uses),
        `external action must use a full commit pin: ${step.uses}`,
      );
    }
  }

  const checkout = requireActionStep(job, "actions/checkout", "checkout");
  const snapshots = requireRunStep(
    job,
    "resolve-apt-snapshots.mjs",
    "APT snapshot preflight",
  );
  requireFailClosed(snapshots.step, "APT snapshot preflight");
  invariant(
    snapshots.index === checkout.index + 1,
    "APT snapshot preflight must run immediately after checkout and before setup or cache work",
  );
  invariant(
    snapshots.step.run.includes(`APT_SNAPSHOTS_SERIALS=\${SNAPSHOTS}`) &&
      snapshots.step.run.includes("$GITHUB_ENV"),
    "APT snapshot preflight must export the exact verified serial map",
  );

  const workspaceInstall = requireRunStep(
    job,
    "bun install --frozen-lockfile --ignore-scripts",
    "frozen workspace install",
  );
  requireOrdered(
    snapshots,
    workspaceInstall,
    "APT snapshot preflight must precede workspace installation",
  );

  const staticContracts = requireRunStep(
    job,
    "verify-riscv64-buildpaths.sh",
    "non-amd64 static contracts",
  );
  requireFailClosed(staticContracts.step, "non-amd64 static contracts");
  invariant(
    staticContracts.step.run.includes(
      "ELIZAOS_STATIC_SOURCE_ONLY=1 ./scripts/static-smoke.sh",
    ),
    "non-amd64 work must remain a source-only static contract",
  );

  const build = requireRunStep(job, "just build", "canonical ISO build");
  requireFailClosed(build.step, "canonical ISO build");
  invariant(
    build.step["working-directory"] === LINUX_DIR_EXPRESSION,
    "canonical ISO build must run from the configured Linux source tree",
  );
  invariant(
    String(build.step.env?.ELIZAOS_BUILD_APP) === "1",
    "canonical ISO build must stage the application",
  );
  requireOrdered(
    staticContracts,
    build,
    "static contracts must pass before the canonical ISO build",
  );

  const locate = requireRunStep(job, "ISO_MAX_BYTES", "ISO finalization");
  requireFailClosed(locate.step, "ISO finalization");
  invariant(locate.step.id === "iso", "ISO finalization must expose id=iso");
  for (const fragment of [
    `\${ELIZAOS_ARCH}`,
    'sha256sum "$DEST"',
    "path=$DEST",
    "filename=$DEST",
    "sha256=",
    "size=$SIZE",
  ]) {
    invariant(
      locate.step.run.includes(fragment),
      `ISO finalization must retain ${fragment}`,
    );
  }
  requireOrdered(build, locate, "ISO finalization must follow the build");

  const boot = requireRunStep(
    job,
    "scripts/smoke-test-iso.sh",
    "dual-firmware ISO boot",
  );
  requireFailClosed(boot.step, "dual-firmware ISO boot");
  invariant(
    boot.step["timeout-minutes"] === 35 &&
      String(boot.step.env?.ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS) === "600",
    "dual-firmware ISO boot must retain bounded step and guest timeouts",
  );
  invariant(
    boot.step.run.includes(ISO_PATH_EXPRESSION) &&
      !/(?:^|\s)-(?:kernel|initrd)(?:\s|$)/m.test(boot.step.run),
    "dual-firmware ISO boot must consume the shipped ISO through its bootloaders",
  );
  for (const dependency of ["ovmf", "qemu-system-x86", "seabios", "xorriso"]) {
    invariant(
      boot.step.run.includes(dependency),
      `dual-firmware ISO boot must install ${dependency}`,
    );
  }
  requireOrdered(
    locate,
    boot,
    "dual-firmware ISO boot must follow ISO finalization",
  );

  const diagnostics = requireActionStep(
    job,
    "actions/upload-artifact",
    "ISO boot diagnostics upload",
  );
  invariant(
    diagnostics.index === boot.index + 1 &&
      diagnostics.step.if === "always()" &&
      diagnostics.step["continue-on-error"] !== true,
    "ISO boot diagnostics must upload immediately after every boot attempt",
  );
  invariant(
    diagnostics.step.with?.path === boot.step.env?.ELIZAOS_ISO_SMOKE_LOG_DIR &&
      diagnostics.step.with?.["if-no-files-found"] === "warn",
    "ISO boot diagnostics must retain the smoke log directory without masking the boot result",
  );

  const provenance = requireActionStep(
    job,
    "actions/attest-build-provenance",
    "SLSA provenance",
  );
  invariant(
    provenance.step.if === undefined &&
      provenance.step["continue-on-error"] !== true &&
      provenance.step.with?.["subject-path"] === ISO_PATH_EXPRESSION,
    "SLSA provenance must attest the finalized ISO",
  );
  requireOrdered(
    boot,
    provenance,
    "SLSA provenance must follow ISO boot validation",
  );

  const extraction = requireRunStep(
    job,
    "unsquashfs",
    "runtime root extraction",
  );
  requireFailClosed(extraction.step, "runtime root extraction");
  invariant(
    extraction.step.id === "sbom-extract",
    "runtime root extraction must expose id=sbom-extract",
  );
  for (const fragment of [
    "/var/lib/dpkg/status",
    "/opt/elizaos",
    "-name package.json",
    "root=$SQ",
  ]) {
    invariant(
      extraction.step.run.includes(fragment),
      `runtime root extraction must validate ${fragment}`,
    );
  }

  const sbom = requireActionStep(job, "anchore/sbom-action", "ISO SBOM");
  invariant(
    sbom.step.if === undefined &&
      sbom.step["continue-on-error"] !== true &&
      sbom.step.with?.path === SBOM_ROOT_EXPRESSION &&
      sbom.step.with?.format === "spdx-json" &&
      sbom.step.with?.["output-file"] ===
        `${ISO_FILENAME_EXPRESSION}.spdx.json` &&
      sbom.step.with?.["upload-artifact"] === false &&
      sbom.step.with?.["upload-release-assets"] === false,
    "ISO SBOM must inventory the extracted runtime root into the retained SPDX file",
  );
  requireOrdered(
    provenance,
    extraction,
    "runtime extraction must follow SLSA provenance",
  );
  requireOrdered(
    extraction,
    sbom,
    "ISO SBOM generation must follow runtime extraction",
  );

  const sbomValidation = requireRunStep(
    job,
    'startswith("pkg:deb/")',
    "ISO SBOM validation",
  );
  requireFailClosed(sbomValidation.step, "ISO SBOM validation");
  invariant(
    sbomValidation.step.run.includes('startswith("pkg:npm/")') &&
      sbomValidation.step.run.includes('"SPDX-2.3"'),
    "ISO SBOM validation must require Debian, npm, and SPDX 2.3 inventory",
  );
  requireOrdered(
    sbom,
    sbomValidation,
    "ISO SBOM validation must follow generation",
  );

  const artifact = job.steps.findIndex(
    (step, index) =>
      index > diagnostics.index &&
      typeof step?.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  invariant(artifact >= 0, "missing final ISO artifact upload");
  const artifactStep = job.steps[artifact];
  invariant(
    artifactStep.if === undefined &&
      artifactStep["continue-on-error"] !== true &&
      artifactStep.with?.["if-no-files-found"] === "error",
    "final ISO artifact upload must fail closed",
  );
  requireArtifactMembers(artifactStep, "final ISO artifact upload");
  invariant(
    sbomValidation.index < artifact,
    "final ISO artifact upload must follow SBOM validation",
  );

  const release = requireActionStep(
    job,
    "softprops/action-gh-release",
    "GitHub release upload",
  );
  requireArtifactMembers(release.step, "GitHub release upload");
  invariant(
    artifact < release.index,
    "GitHub release upload must follow retained artifact upload",
  );

  return { ok: true };
}

export function validateLinuxIsoWorkflowSource(source) {
  return validateLinuxIsoWorkflow(parseLinuxIsoWorkflow(source));
}

export function validateLinuxIsoWorkflowRegistration(source) {
  const workflow = parseWorkflowSource(source, VALIDATION_WORKFLOW_PATH);
  const pullRequest = workflow.on?.pull_request;
  const branches = pullRequest?.branches;
  workflowInvariant(
    VALIDATION_WORKFLOW_PATH,
    Array.isArray(branches) && branches.includes("develop"),
    "OS release validation must run for pull requests targeting develop",
  );
  const paths = pullRequest?.paths;
  workflowInvariant(
    VALIDATION_WORKFLOW_PATH,
    Array.isArray(paths) && paths.includes(WORKFLOW_PATH),
    `pull requests changing ${WORKFLOW_PATH} must run OS release validation`,
  );

  const job = workflow.jobs?.["validate-os-release"];
  const steps = job?.steps;
  workflowInvariant(
    VALIDATION_WORKFLOW_PATH,
    Array.isArray(steps) &&
      steps.some(
        (step) =>
          typeof step?.run === "string" &&
          step.run.includes(
            "ELIZAOS_STATIC_SOURCE_ONLY=1 ./scripts/static-smoke.sh",
          ),
      ),
    "OS release validation must execute the Linux static contract gate",
  );
  return { ok: true };
}

export function run(repoRoot = REPO_ROOT) {
  validateLinuxIsoWorkflowSource(
    readFileSync(path.join(repoRoot, WORKFLOW_PATH), "utf8"),
  );
  validateLinuxIsoWorkflowRegistration(
    readFileSync(path.join(repoRoot, VALIDATION_WORKFLOW_PATH), "utf8"),
  );
  return { ok: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  run();
  process.stdout.write("linux ISO workflow contract passed\n");
}
