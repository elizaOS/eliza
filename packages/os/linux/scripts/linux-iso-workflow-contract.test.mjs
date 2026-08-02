/**
 * Mutates the real Linux ISO workflow to prove release-critical regressions
 * fail before image construction or publication.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  parseLinuxIsoWorkflow,
  validateLinuxIsoWorkflow,
  validateLinuxIsoWorkflowRegistration,
  validateLinuxIsoWorkflowSource,
} from "./linux-iso-workflow-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const workflowSource = readFileSync(
  path.join(repoRoot, ".github/workflows/build-linux-iso.yml"),
  "utf8",
);
const validationWorkflowSource = readFileSync(
  path.join(repoRoot, ".github/workflows/elizaos-os-release.yml"),
  "utf8",
);
const isoFilenameExpression = `\${{ steps.iso.outputs.filename }}`;

function buildJob(workflow) {
  return workflow.jobs["build-iso"];
}

function stepNamed(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `expected workflow step ${name}`);
  return step;
}

test("accepts the canonical Linux ISO release workflow", () => {
  assert.deepEqual(validateLinuxIsoWorkflowSource(workflowSource), {
    ok: true,
  });
});

test("keeps the ISO workflow registered with the OS validation gate", () => {
  assert.deepEqual(
    validateLinuxIsoWorkflowRegistration(validationWorkflowSource),
    { ok: true },
  );
});

test("rejects an unreachable ISO workflow contract", () => {
  const source = validationWorkflowSource.replace(
    '      - ".github/workflows/build-linux-iso.yml"\n',
    "",
  );
  assert.throws(
    () => validateLinuxIsoWorkflowRegistration(source),
    /must run OS release validation/,
  );
});

test("rejects OS validation that skips develop pull requests", () => {
  const source = validationWorkflowSource.replace(
    "    branches: [main, develop]\n",
    "    branches: [main]\n",
  );
  assert.throws(
    () => validateLinuxIsoWorkflowRegistration(source),
    /must run for pull requests targeting develop/,
  );
});

for (const fixture of [
  {
    name: "an unsupported release architecture",
    mutate: (job) => {
      job.env.ELIZAOS_ARCH = "arm64";
    },
    pattern: /publish only the canonical amd64 architecture/,
  },
  {
    name: "an architecture matrix",
    mutate: (job) => {
      job.strategy = { matrix: { architecture: ["amd64", "arm64"] } };
    },
    pattern: /may not advertise an architecture matrix/,
  },
  {
    name: "APT preflight after workspace installation",
    mutate: (job) => {
      const index = job.steps.findIndex(
        (step) => step.name === "Resolve available Tails APT snapshots",
      );
      const [preflight] = job.steps.splice(index, 1);
      const installIndex = job.steps.findIndex(
        (step) =>
          step.name === "Install workspace dependencies from frozen lockfile",
      );
      job.steps.splice(installIndex + 1, 0, preflight);
    },
    pattern: /must run immediately after checkout/,
  },
  {
    name: "an unexported verified snapshot map",
    mutate: (job) => {
      const step = stepNamed(job, "Resolve available Tails APT snapshots");
      step.run = step.run.replace("$GITHUB_ENV", "/tmp/snapshots");
    },
    pattern: /must export the exact verified serial map/,
  },
  {
    name: "non-amd64 artifact construction",
    mutate: (job) => {
      const step = stepNamed(job, "Verify non-amd64 static contracts");
      step.run = step.run.replace(
        "ELIZAOS_STATIC_SOURCE_ONLY=1",
        "ELIZAOS_STATIC_SOURCE_ONLY=0",
      );
    },
    pattern: /must remain a source-only static contract/,
  },
  {
    name: "an ISO build without a staged runtime health check",
    mutate: (job) => {
      const step = stepNamed(job, "Build ISO (amd64)");
      step.run = step.run.replace("just runtime-smoke\n", "");
    },
    pattern: /must start and health-check the staged runtime/,
  },
  {
    name: "a floating third-party action reference",
    mutate: (job) => {
      stepNamed(job, "Checkout").uses = "actions/checkout@v7";
    },
    pattern: /external action must use a full commit pin/,
  },
  {
    name: "a direct kernel boot bypass",
    mutate: (job) => {
      const step = stepNamed(job, "Smoke test ISO through SeaBIOS and OVMF");
      step.run += "\nqemu-system-x86_64 -kernel vmlinuz -initrd initrd.img\n";
    },
    pattern: /must consume the shipped ISO through its bootloaders/,
  },
  {
    name: "a permissive firmware boot",
    mutate: (job) => {
      stepNamed(job, "Smoke test ISO through SeaBIOS and OVMF")[
        "continue-on-error"
      ] = true;
    },
    pattern: /dual-firmware ISO boot may not continue on error/,
  },
  {
    name: "a shortened firmware boot timeout",
    mutate: (job) => {
      stepNamed(job, "Smoke test ISO through SeaBIOS and OVMF").env[
        "ELIZAOS_ISO_SMOKE_TIMEOUT_SECONDS"
      ] = 600;
    },
    pattern: /must retain bounded step and guest timeouts/,
  },
  {
    name: "a firmware CPU below the bundled Bun ABI",
    mutate: (job) => {
      stepNamed(job, "Smoke test ISO through SeaBIOS and OVMF").env[
        "ELIZAOS_ISO_SMOKE_CPU_MODEL"
      ] = "qemu64";
    },
    pattern: /must expose the x86-64-v3 CPU required by bundled Bun/,
  },
  {
    name: "success-only boot diagnostics",
    mutate: (job) => {
      stepNamed(job, "Upload ISO boot diagnostics").if = "success()";
    },
    pattern: /diagnostics must upload immediately after every boot attempt/,
  },
  {
    name: "provenance for a different subject",
    mutate: (job) => {
      stepNamed(job, "Attest SLSA build provenance for ISO").with[
        "subject-path"
      ] = "unverified.iso";
    },
    pattern: /must attest the finalized ISO/,
  },
  {
    name: "permissive provenance",
    mutate: (job) => {
      stepNamed(job, "Attest SLSA build provenance for ISO")[
        "continue-on-error"
      ] = true;
    },
    pattern: /must attest the finalized ISO/,
  },
  {
    name: "runtime extraction without Debian inventory",
    mutate: (job) => {
      const step = stepNamed(job, "Extract full runtime root from ISO");
      step.run = step.run.replace("/var/lib/dpkg/status", "/tmp/status");
    },
    pattern: /must validate \/var\/lib\/dpkg\/status/,
  },
  {
    name: "an SBOM detached from the retained artifact",
    mutate: (job) => {
      stepNamed(job, "Generate ISO SBOM (SPDX 2.3 JSON)").with["output-file"] =
        "temporary.spdx.json";
    },
    pattern: /must inventory the extracted runtime root/,
  },
  {
    name: "a permissive final artifact upload",
    mutate: (job) => {
      stepNamed(job, "Upload ISO artifact").with["if-no-files-found"] = "warn";
    },
    pattern: /final ISO artifact upload must fail closed/,
  },
  {
    name: "an artifact without its checksum",
    mutate: (job) => {
      const step = stepNamed(job, "Upload ISO artifact");
      step.with.path = step.with.path.replace(
        `${isoFilenameExpression}.sha256\n`,
        "",
      );
    },
    pattern: /final ISO artifact upload must include .*\.sha256/,
  },
]) {
  test(`rejects ${fixture.name}`, () => {
    const workflow = parseLinuxIsoWorkflow(workflowSource);
    fixture.mutate(buildJob(workflow));
    assert.throws(() => validateLinuxIsoWorkflow(workflow), fixture.pattern);
  });
}
