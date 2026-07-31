#!/usr/bin/env node
/**
 * Enforces the fail-closed build and installed-runtime contract for Snap.
 * The validator parses workflow structure before inspecting exact critical
 * scripts, so comments, disabled steps, and shell error masking cannot stand
 * in for executable amd64 and arm64 package proof.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const FILE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(FILE_DIR, "../../..");
const DEFAULT_WORKFLOW_PATH = resolve(
  REPO_ROOT,
  ".github/workflows/snap-build-test.yml",
);
const DEFAULT_STANDALONE_PUBLISH_PATH = resolve(
  REPO_ROOT,
  ".github/workflows/snap-publish.yml",
);
const DEFAULT_AGGREGATE_PUBLISH_PATH = resolve(
  REPO_ROOT,
  ".github/workflows/publish-packages.yml",
);
const DEFAULT_PACKAGING_WORKFLOW_PATH = resolve(
  REPO_ROOT,
  ".github/workflows/test-packaging.yml",
);
const DEFAULT_MANIFEST_PATH = resolve(
  REPO_ROOT,
  "packages/app-core/packaging/snap/snapcraft.yaml",
);
const DEFAULT_INSTALLED_SMOKE_PATH = resolve(
  REPO_ROOT,
  "packages/app-core/packaging/snap/test-installed-snap.sh",
);
const DEFAULT_PACKAGING_HARNESS_PATH = resolve(
  REPO_ROOT,
  "packages/app-core/packaging/test-packaging.sh",
);
const CI_BUN_VERSION_PATH = resolve(REPO_ROOT, ".github/ci-bun-version.json");
const ROOT_MANIFEST_PATH = resolve(REPO_ROOT, "package.json");

const CHECKOUT_ACTION =
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const SETUP_BUN_ACTION =
  "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
const SETUP_BUF_ACTION =
  "bufbuild/buf-setup-action@a47c93e0b1648d5651a065437926377d060baa99";
const SNAP_BUILD_ACTION =
  "snapcore/action-build@3bdaa03e1ba6bf59a65f84a751d943d549a54e79";
const UPLOAD_ARTIFACT_ACTION =
  "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const DOWNLOAD_ARTIFACT_ACTION =
  "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c";
const SBOM_ACTION =
  "anchore/sbom-action@e22c389904149dbc22b58101806040fa8d37a610";
const ATTEST_ACTION =
  "actions/attest-build-provenance@0f67c3f4856b2e3261c31976d6725780e5e4c373";
const SNAP_PUBLISH_ACTION =
  "snapcore/action-publish@214b86e5ca036ead1668c79afb81e550e6c54d40";
const BUF_VERSION = "1.50.0";
const SNAP_OUTPUT_EXPRESSION = "$" + "{{ steps.snapcraft.outputs.snap }}";
const SBOM_ROOT_EXPRESSION = "$" + "{{ steps.sbom-root.outputs.path }}";
const INPUT_VERSION_EXPRESSION = "$" + "{{ inputs.version }}";
const INPUT_TAG_EXPRESSION = "$" + "{{ inputs.tag }}";
const PREPARED_VERSION_EXPRESSION = "$" + "{{ needs.prepare.outputs.version }}";
const INPUT_CHANNEL_EXPRESSION = "$" + "{{ inputs.channel }}";
const PREPARED_PRERELEASE_EXPRESSION =
  "$" + "{{ needs.prepare.outputs.is_prerelease }}";
const PREPARED_CHANNEL_EXPRESSION =
  "$" +
  "{{ needs.prepare.outputs.is_prerelease == 'true' && 'edge,beta' || 'stable,candidate' }}";
const STANDALONE_STORE_CREDENTIALS_EXPRESSION =
  "$" + "{{ secrets.SNAPCRAFT_STORE_CREDENTIALS }}";
const AGGREGATE_STORE_CREDENTIALS_EXPRESSION =
  "$" + "{{ secrets.SNAP_STORE_CREDENTIALS }}";
const MATRIX_RUNNER_EXPRESSION = "$" + "{{ matrix.runner }}";
const MATRIX_ARCH_EXPRESSION = "$" + "{{ matrix.arch }}";
const PR_HEAD_OR_TRIGGER_SHA_EXPRESSION =
  "$" +
  "{{ github.event_name == 'pull_request' && github.event.pull_request.head.sha || github.sha }}";
const SHELL_VERSION_EXPANSION = "$" + "{VERSION}";
const SHELL_GRADE_EXPANSION = "$" + "{SNAP_GRADE}";

const NODE_SHA256 = {
  amd64: "472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6",
  arm64: "f3d5a797b5d210ce8e2cb265544c8e482eaedcb8aa409a8b46da7e8595d0dda0",
};

const BUN_SHA256 = {
  amd64: "951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f",
  arm64: "a27ffb63a8310375836e0d6f668ae17fa8d8d18b88c37c821c65331973a19a3b",
};

const NODE_DOWNLOAD_URL_LINE = `"https://nodejs.org/dist/v\${NODE_VERSION}/node-v\${NODE_VERSION}-linux-\${NODE_ARCH}.tar.xz" \\`;
const BUN_DOWNLOAD_URL_LINE = `"https://github.com/oven-sh/bun/releases/download/bun-v\${BUN_VERSION}/bun-linux-\${BUN_ARCH}.zip" \\`;

const EXPECTED_PREPARE_SCRIPT = [
  "set -euo pipefail",
  "mkdir -p snap",
  "cp packages/app-core/packaging/snap/snapcraft.yaml snap/snapcraft.yaml",
  `VERSION="$(node -p 'require("./package.json").version')"`,
  'test -n "$VERSION"',
  `sed -i "s/^version: .*/version: '${SHELL_VERSION_EXPANSION}'/" snap/snapcraft.yaml`,
  'echo "Building snap version: $VERSION"',
];

const EXPECTED_INSTALL_SCRIPT = [
  "set -euo pipefail",
  'test -n "$SNAP_PATH"',
  'test -f "$SNAP_PATH"',
  `EXPECTED_VERSION="$(node -p 'require("./package.json").version')"`,
  'test -n "$EXPECTED_VERSION"',
  "export EXPECTED_VERSION",
  "bash packages/app-core/packaging/snap/test-installed-snap.sh",
];

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  invariant(isRecord(value), `${label} must be a mapping`);
  return value;
}

function parseYamlMapping(source, label) {
  const document = parseDocument(source, {
    prettyErrors: false,
    uniqueKeys: true,
  });
  invariant(
    document.errors.length === 0,
    `${label} is invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`,
  );
  return requireRecord(document.toJS({ maxAliasCount: 0 }), label);
}

function requireOwn(record, key, label) {
  invariant(Object.hasOwn(record, key), `${label} must define ${key}`);
  return record[key];
}

function requireExactStringArray(value, expected, label) {
  invariant(Array.isArray(value), `${label} must be a list`);
  invariant(
    value.length === expected.length &&
      value.every((entry, index) => entry === expected[index]),
    `${label} must equal [${expected.join(", ")}]`,
  );
}

function scriptLines(value, label) {
  invariant(typeof value === "string", `${label} must be an executable script`);
  return value
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function activeScriptLines(value, label) {
  return scriptLines(value, label).filter((line) => !line.startsWith("#"));
}

function requireExactScript(value, expected, label) {
  const actual = scriptLines(value, label);
  invariant(
    actual.length === expected.length &&
      actual.every((line, index) => line === expected[index]),
    `${label} must match the fail-closed executable contract exactly`,
  );
}

function findUniqueStep(steps, name) {
  const matches = steps.filter((step) => isRecord(step) && step.name === name);
  invariant(
    matches.length === 1,
    `workflow must contain exactly one '${name}' step`,
  );
  return matches[0];
}

function requireNoConditionalOrErrorOverride(record, label) {
  invariant(!Object.hasOwn(record, "if"), `${label} must not be conditional`);
  invariant(
    !Object.hasOwn(record, "continue-on-error"),
    `${label} must not continue on error`,
  );
}

function requireOrderedLines(lines, expected, label) {
  let previousIndex = -1;
  for (const line of expected) {
    const index = lines.indexOf(line, previousIndex + 1);
    invariant(
      index > previousIndex,
      `${label} must execute '${line}' in order`,
    );
    previousIndex = index;
  }
}

function multilineEntries(value, label) {
  invariant(typeof value === "string", `${label} must be a multiline string`);
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateArchitectureMatrix(buildJob, label) {
  invariant(
    buildJob["runs-on"] === MATRIX_RUNNER_EXPRESSION,
    `${label} must bind runs-on to matrix.runner`,
  );
  invariant(
    buildJob["timeout-minutes"] === 90,
    `${label} must time out after 90 minutes`,
  );
  invariant(
    !Object.hasOwn(buildJob, "container"),
    `${label} must run directly on its bound runner`,
  );
  invariant(
    !Object.hasOwn(buildJob, "services"),
    `${label} must not replace the runner with a service container`,
  );
  invariant(
    !Object.hasOwn(buildJob, "defaults"),
    `${label} must not override run-shell semantics`,
  );

  const strategy = requireRecord(buildJob.strategy, `${label} strategy`);
  invariant(
    strategy["fail-fast"] === false,
    `${label} matrix must retain diagnostics from both architectures`,
  );
  invariant(
    !Object.hasOwn(strategy, "max-parallel"),
    `${label} matrix must not serialize or suppress an architecture`,
  );
  const matrix = requireRecord(strategy.matrix, `${label} matrix`);
  invariant(
    !Object.hasOwn(matrix, "exclude"),
    `${label} matrix must not exclude a supported architecture`,
  );
  invariant(
    Array.isArray(matrix.include),
    `${label} matrix include must be a list`,
  );
  invariant(
    matrix.include.length === 2,
    `${label} matrix must contain exactly two supported architectures`,
  );
  const expectedRunners = new Map([
    ["amd64", "ubuntu-24.04"],
    ["arm64", "ubuntu-24.04-arm"],
  ]);
  for (const entryValue of matrix.include) {
    const entry = requireRecord(entryValue, `${label} matrix entry`);
    const expectedRunner = expectedRunners.get(entry.arch);
    invariant(
      expectedRunner,
      `unsupported ${label} architecture '${String(entry.arch)}'`,
    );
    invariant(
      entry.runner === expectedRunner,
      `${entry.arch} must run on ${expectedRunner}`,
    );
    invariant(
      !Object.hasOwn(entry, "experimental"),
      `${entry.arch} must be blocking`,
    );
    invariant(
      Object.keys(entry).length === 2,
      `${entry.arch} matrix entry may define only arch and runner`,
    );
    expectedRunners.delete(entry.arch);
  }
  invariant(
    expectedRunners.size === 0,
    `${label} matrix must cover amd64 and arm64`,
  );
}

function requireStepExecution(step, label, expectedIf) {
  invariant(
    !Object.hasOwn(step, "continue-on-error"),
    `${label} must not continue on error`,
  );
  invariant(
    !Object.hasOwn(step, "shell"),
    `${label} must not override GitHub's fail-closed shell`,
  );
  invariant(
    !Object.hasOwn(step, "working-directory"),
    `${label} must execute from the repository root`,
  );
  if (expectedIf === undefined) {
    invariant(!Object.hasOwn(step, "if"), `${label} must not be conditional`);
  } else {
    invariant(
      step.if === expectedIf,
      `${label} must use condition '${expectedIf}'`,
    );
  }
}

function validateBuildAction(build, label) {
  requireStepExecution(build, label);
  invariant(
    build.uses === SNAP_BUILD_ACTION,
    `${label} action must be commit-pinned`,
  );
  invariant(
    build.id === "snapcraft",
    `${label} must expose the snapcraft output id`,
  );
  const inputs = requireRecord(build.with, `${label} inputs`);
  invariant(
    inputs.path === ".",
    `${label} must build source from the repository root`,
  );
  invariant(
    inputs["build-info"] === true,
    `${label} must embed Snapcraft build information`,
  );
  invariant(
    inputs["snapcraft-channel"] === "8.x/stable",
    `${label} must pin the Snapcraft major track`,
  );
}

function validateSnapBuildJob(
  buildJob,
  {
    label,
    expectedBunVersion,
    expectedNeeds,
    expectedJobIf,
    expectedPrepareScript,
    expectedPrepareVersionEnv,
    expectedPrepareChannelEnv,
    expectedPreparePrereleaseEnv,
    expectedVersionEnv,
    uploadStepName,
    uploadRetention,
    attestationCondition,
    attestationInBuild = true,
    publish,
    allowedExtraSteps = [],
    expectedCheckoutRef,
    expectedSourceRevision,
  },
) {
  if (expectedNeeds === undefined) {
    invariant(
      !Object.hasOwn(buildJob, "needs"),
      `${label} must not depend on another job`,
    );
  } else {
    invariant(
      buildJob.needs === expectedNeeds,
      `${label} must need only ${expectedNeeds}`,
    );
  }
  if (expectedJobIf === undefined) {
    invariant(
      !Object.hasOwn(buildJob, "if"),
      `${label} must not be conditional`,
    );
  } else {
    invariant(
      buildJob.if === expectedJobIf,
      `${label} must use job condition '${expectedJobIf}'`,
    );
  }
  invariant(
    !Object.hasOwn(buildJob, "continue-on-error"),
    `${label} must be blocking`,
  );
  const permissions = requireRecord(
    buildJob.permissions,
    `${label} permissions`,
  );
  if (attestationInBuild) {
    invariant(
      permissions.contents === "read" &&
        permissions["id-token"] === "write" &&
        permissions.attestations === "write" &&
        Object.keys(permissions).length === 3,
      `${label} must grant only read contents plus OIDC attestation permissions`,
    );
  } else {
    invariant(
      permissions.contents === "read" && Object.keys(permissions).length === 1,
      `${label} must grant only read contents permissions`,
    );
  }
  validateArchitectureMatrix(buildJob, label);
  invariant(Array.isArray(buildJob.steps), `${label} steps must be a list`);
  const steps = buildJob.steps;
  const allowedStepNames = new Set([
    "Checkout",
    "Setup Bun",
    "Setup Buf",
    "Prepare snapcraft.yaml",
    "Build snap",
    "Verify snap contents",
    "Install and test snap",
    "Record builder and base provenance",
    "Extract snap filesystem for SBOM",
    "Generate Snap SBOM",
    uploadStepName,
    "Upload Snap diagnostics after failure",
    ...allowedExtraSteps,
  ]);
  if (attestationInBuild) allowedStepNames.add("Attest Snap build provenance");
  if (publish) allowedStepNames.add("Publish to Snap Store");
  const seenStepNames = new Set();

  const allowedConditions = new Map([
    ["Upload Snap diagnostics after failure", "failure()"],
  ]);
  if (attestationInBuild)
    allowedConditions.set("Attest Snap build provenance", attestationCondition);
  if (publish)
    allowedConditions.set("Publish to Snap Store", publish.condition);
  for (const [index, stepValue] of steps.entries()) {
    const step = requireRecord(stepValue, `${label} step ${index + 1}`);
    invariant(
      typeof step.name === "string" && allowedStepNames.has(step.name),
      `${label} contains unexpected step '${String(step.name ?? index + 1)}'`,
    );
    invariant(
      !seenStepNames.has(step.name),
      `${label} step names must be unique`,
    );
    seenStepNames.add(step.name);
    requireStepExecution(
      step,
      `${label} step '${String(step.name ?? index + 1)}'`,
      allowedConditions.get(step.name),
    );
  }

  const checkout = findUniqueStep(steps, "Checkout");
  invariant(
    checkout.uses === CHECKOUT_ACTION,
    `${label} checkout must be commit-pinned`,
  );
  invariant(
    requireRecord(checkout.with, `${label} checkout inputs`).submodules ===
      false,
    `${label} checkout must skip unused submodules`,
  );
  const checkoutInputs = requireRecord(
    checkout.with,
    `${label} checkout inputs`,
  );
  if (expectedCheckoutRef === undefined) {
    invariant(
      !Object.hasOwn(checkoutInputs, "ref"),
      `${label} checkout must use the triggering commit`,
    );
  } else {
    invariant(
      checkoutInputs.ref === expectedCheckoutRef,
      `${label} checkout must use the expected source ref`,
    );
  }

  const setupBun = findUniqueStep(steps, "Setup Bun");
  invariant(
    setupBun.uses === SETUP_BUN_ACTION,
    `${label} Setup Bun action must be commit-pinned`,
  );
  invariant(
    requireRecord(setupBun.with, `${label} Setup Bun inputs`)["bun-version"] ===
      expectedBunVersion,
    `${label} Setup Bun must use ${expectedBunVersion}`,
  );
  const setupBuf = findUniqueStep(steps, "Setup Buf");
  invariant(
    setupBuf.uses === SETUP_BUF_ACTION,
    `${label} Setup Buf action must be commit-pinned`,
  );
  invariant(
    requireRecord(setupBuf.with, `${label} Setup Buf inputs`).version ===
      BUF_VERSION,
    `${label} Setup Buf must use ${BUF_VERSION}`,
  );

  const prepare = findUniqueStep(steps, "Prepare snapcraft.yaml");
  if (expectedPrepareVersionEnv !== undefined) {
    const prepareEnv = requireRecord(
      prepare.env,
      `${label} prepare environment`,
    );
    invariant(
      prepareEnv.VERSION === expectedPrepareVersionEnv,
      `${label} prepare must receive the requested version through env`,
    );
    const expectedEnvironmentKeys = ["VERSION"];
    if (expectedPrepareChannelEnv !== undefined) {
      invariant(
        prepareEnv.CHANNEL === expectedPrepareChannelEnv,
        `${label} prepare must derive grade from the requested channel`,
      );
      expectedEnvironmentKeys.push("CHANNEL");
    }
    if (expectedPreparePrereleaseEnv !== undefined) {
      invariant(
        prepareEnv.IS_PRERELEASE === expectedPreparePrereleaseEnv,
        `${label} prepare must derive grade from the release classification`,
      );
      expectedEnvironmentKeys.push("IS_PRERELEASE");
    }
    invariant(
      Object.keys(prepareEnv).length === expectedEnvironmentKeys.length &&
        expectedEnvironmentKeys.every((key) => Object.hasOwn(prepareEnv, key)),
      `${label} prepare environment must contain only grade-bound release inputs`,
    );
  } else {
    invariant(
      !Object.hasOwn(prepare, "env"),
      `${label} prepare must derive version from trusted repository data`,
    );
  }
  requireExactScript(
    prepare.run,
    expectedPrepareScript,
    `${label} Prepare snapcraft.yaml step`,
  );

  const build = findUniqueStep(steps, "Build snap");
  validateBuildAction(build, `${label} Build snap step`);

  const verify = findUniqueStep(steps, "Verify snap contents");
  const verifyEnv = requireRecord(verify.env, `${label} verify environment`);
  invariant(
    verifyEnv.SNAP_PATH === SNAP_OUTPUT_EXPRESSION,
    `${label} verify must consume the built artifact output`,
  );
  invariant(
    verifyEnv.EVIDENCE_DIR === `snap-evidence/${MATRIX_ARCH_EXPRESSION}`,
    `${label} verify evidence must be architecture-scoped`,
  );
  const verifyLines = activeScriptLines(verify.run, `${label} verify script`);
  invariant(
    verifyLines[0] === "set -euo pipefail",
    `${label} verify must start fail closed`,
  );
  requireOrderedLines(
    verifyLines,
    [
      'test -n "$SNAP_PATH"',
      'test -f "$SNAP_PATH"',
      'mkdir -p "$EVIDENCE_DIR"',
      'SNAP_SHA256="$(sha256sum "$SNAP_PATH" | awk \'{ print $1 }\')"',
      `printf '%s  %s\\n' "$SNAP_SHA256" "$(basename "$SNAP_PATH")" | tee "$EVIDENCE_DIR/SHA256SUMS"`,
    ],
    `${label} verify`,
  );

  const install = findUniqueStep(steps, "Install and test snap");
  const installEnv = requireRecord(
    install.env,
    `${label} installed proof environment`,
  );
  invariant(
    installEnv.SNAP_PATH === SNAP_OUTPUT_EXPRESSION,
    `${label} installed proof must consume the built artifact output`,
  );
  invariant(
    installEnv.EXPECTED_ARCH === MATRIX_ARCH_EXPRESSION,
    `${label} installed proof must consume matrix.arch`,
  );
  invariant(
    installEnv.EVIDENCE_DIR ===
      `snap-evidence/${MATRIX_ARCH_EXPRESSION}/installed`,
    `${label} installed proof evidence must be architecture-scoped`,
  );
  if (expectedVersionEnv === undefined) {
    requireExactScript(
      install.run,
      EXPECTED_INSTALL_SCRIPT,
      `${label} installed proof step`,
    );
  } else {
    invariant(
      installEnv.EXPECTED_VERSION === expectedVersionEnv,
      `${label} installed proof must consume the release version`,
    );
    requireExactScript(
      install.run,
      ["bash packages/app-core/packaging/snap/test-installed-snap.sh"],
      `${label} installed proof step`,
    );
  }

  const provenance = findUniqueStep(
    steps,
    "Record builder and base provenance",
  );
  const provenanceEnv = requireRecord(
    provenance.env,
    `${label} provenance environment`,
  );
  invariant(
    provenanceEnv.SNAP_PATH === SNAP_OUTPUT_EXPRESSION,
    `${label} provenance must consume the built artifact output`,
  );
  if (expectedSourceRevision !== undefined) {
    invariant(
      provenanceEnv.EXPECTED_SOURCE_REVISION === expectedSourceRevision,
      `${label} provenance must receive the expected source revision`,
    );
  }
  const provenanceLines = activeScriptLines(
    provenance.run,
    `${label} provenance script`,
  );
  invariant(
    provenanceLines[0] === "set -euo pipefail",
    `${label} provenance must start fail closed`,
  );
  if (expectedSourceRevision !== undefined) {
    requireOrderedLines(
      provenanceLines,
      [
        'SOURCE_REVISION="$(git rev-parse HEAD)"',
        'test "$SOURCE_REVISION" = "$EXPECTED_SOURCE_REVISION"',
        `printf 'source_revision=%s\\n' "$SOURCE_REVISION"`,
      ],
      `${label} source provenance`,
    );
  }
  for (const required of [
    "snap version",
    "snapcraft version",
    "snap list snapcraft",
    "snap list core22",
    'unsquashfs -cat "$SNAP_PATH" snap/manifest.yaml >"$EVIDENCE_DIR/build-manifest.yaml"',
  ]) {
    invariant(
      provenanceLines.includes(required),
      `${label} provenance must execute '${required}'`,
    );
  }

  const extract = findUniqueStep(steps, "Extract snap filesystem for SBOM");
  invariant(
    extract.id === "sbom-root",
    `${label} SBOM extraction must expose its path`,
  );
  invariant(
    requireRecord(extract.env, `${label} SBOM extraction environment`)
      .SNAP_PATH === SNAP_OUTPUT_EXPRESSION,
    `${label} SBOM extraction must consume the built artifact`,
  );
  const extractLines = activeScriptLines(
    extract.run,
    `${label} SBOM extraction script`,
  );
  invariant(
    extractLines[0] === "set -euo pipefail",
    `${label} SBOM extraction must start fail closed`,
  );
  requireOrderedLines(
    extractLines,
    [
      'test -f "$SNAP_PATH"',
      'unsquashfs -d "$SBOM_ROOT" "$SNAP_PATH" >/dev/null',
      'test -f "$SBOM_ROOT/meta/snap.yaml"',
      'test -f "$SBOM_ROOT/snap/manifest.yaml"',
      'echo "path=$SBOM_ROOT" >> "$GITHUB_OUTPUT"',
    ],
    `${label} SBOM extraction`,
  );

  const sbom = findUniqueStep(steps, "Generate Snap SBOM");
  invariant(
    sbom.uses === SBOM_ACTION,
    `${label} SBOM action must be commit-pinned`,
  );
  const sbomInputs = requireRecord(sbom.with, `${label} SBOM inputs`);
  invariant(
    sbomInputs.path === SBOM_ROOT_EXPRESSION,
    `${label} SBOM must scan the extracted artifact`,
  );
  invariant(
    sbomInputs.format === "spdx-json",
    `${label} SBOM must use SPDX JSON`,
  );
  invariant(
    sbomInputs["output-file"] ===
      `snap-evidence/${MATRIX_ARCH_EXPRESSION}/elizaos-app-${MATRIX_ARCH_EXPRESSION}.spdx.json`,
    `${label} SBOM output must be architecture-scoped`,
  );
  invariant(
    sbomInputs["upload-artifact"] === false &&
      sbomInputs["upload-release-assets"] === false,
    `${label} SBOM upload must remain in the combined artifact`,
  );

  let attestation;
  if (attestationInBuild) {
    attestation = findUniqueStep(steps, "Attest Snap build provenance");
    invariant(
      attestation.uses === ATTEST_ACTION,
      `${label} attestation action must be commit-pinned`,
    );
    invariant(
      requireRecord(attestation.with, `${label} attestation inputs`)[
        "subject-path"
      ] === SNAP_OUTPUT_EXPRESSION,
      `${label} attestation must cover the built artifact`,
    );
  }

  const upload = findUniqueStep(steps, uploadStepName);
  invariant(
    upload.uses === UPLOAD_ARTIFACT_ACTION,
    `${label} upload action must be commit-pinned`,
  );
  const uploadInputs = requireRecord(upload.with, `${label} upload inputs`);
  requireExactStringArray(
    multilineEntries(uploadInputs.path, `${label} upload path`),
    [SNAP_OUTPUT_EXPRESSION, `snap-evidence/${MATRIX_ARCH_EXPRESSION}/`],
    `${label} upload paths`,
  );
  invariant(
    uploadInputs["if-no-files-found"] === "error",
    `${label} upload must fail when artifact or evidence is absent`,
  );
  invariant(
    uploadInputs["retention-days"] === uploadRetention,
    `${label} upload retention must be ${uploadRetention} days`,
  );

  const diagnostics = findUniqueStep(
    steps,
    "Upload Snap diagnostics after failure",
  );
  invariant(
    diagnostics.uses === UPLOAD_ARTIFACT_ACTION,
    `${label} diagnostics upload action must be commit-pinned`,
  );
  const diagnosticsInputs = requireRecord(
    diagnostics.with,
    `${label} diagnostics inputs`,
  );
  invariant(
    diagnosticsInputs.path === `snap-evidence/${MATRIX_ARCH_EXPRESSION}/`,
    `${label} diagnostics must retain architecture-scoped logs`,
  );
  invariant(
    diagnosticsInputs["if-no-files-found"] === "warn",
    `${label} early failures may lack diagnostics but must remain visible`,
  );

  const ordered = [build, verify, install, provenance, extract, sbom];
  if (attestation) ordered.push(attestation);
  ordered.push(upload);
  if (publish) {
    const publishStep = findUniqueStep(steps, "Publish to Snap Store");
    invariant(
      publishStep.uses === SNAP_PUBLISH_ACTION,
      `${label} publish action must be commit-pinned`,
    );
    const publishInputs = requireRecord(
      publishStep.with,
      `${label} publish inputs`,
    );
    invariant(
      publishInputs.snap === SNAP_OUTPUT_EXPRESSION,
      `${label} publish must consume the tested artifact`,
    );
    invariant(
      publishInputs.release === publish.release,
      `${label} publish must use the requested release channel`,
    );
    ordered.push(publishStep);
  }
  ordered.push(diagnostics);
  invariant(
    ordered.every(
      (step, index) =>
        index === 0 || steps.indexOf(step) > steps.indexOf(ordered[index - 1]),
    ),
    `${label} build, proof, provenance, SBOM, attestation, upload, and publish must preserve dataflow order`,
  );
}

function validateTrustedSnapAttestationJob(job) {
  const label = "attest-snap job";
  invariant(job.needs === "build-snap", `${label} must need build-snap`);
  invariant(
    job.if === "github.event_name != 'pull_request'",
    `${label} must never run for pull requests`,
  );
  invariant(
    job["runs-on"] === "ubuntu-24.04",
    `${label} must run on the pinned trusted runner image`,
  );
  invariant(
    job["timeout-minutes"] === 10,
    `${label} must time out after 10 minutes`,
  );
  invariant(
    !Object.hasOwn(job, "continue-on-error"),
    `${label} must be blocking`,
  );
  for (const forbidden of ["container", "services", "defaults"]) {
    invariant(
      !Object.hasOwn(job, forbidden),
      `${label} must not define ${forbidden}`,
    );
  }

  const permissions = requireRecord(job.permissions, `${label} permissions`);
  invariant(
    permissions.contents === "read" &&
      permissions["id-token"] === "write" &&
      permissions.attestations === "write" &&
      Object.keys(permissions).length === 3,
    `${label} must grant only read contents plus OIDC attestation permissions`,
  );

  const strategy = requireRecord(job.strategy, `${label} strategy`);
  invariant(
    strategy["fail-fast"] === false,
    `${label} must preserve per-architecture diagnostics`,
  );
  invariant(
    !Object.hasOwn(strategy, "max-parallel"),
    `${label} must not suppress an architecture`,
  );
  const matrix = requireRecord(strategy.matrix, `${label} matrix`);
  requireExactStringArray(
    requireOwn(matrix, "arch", `${label} matrix`),
    ["amd64", "arm64"],
    `${label} architectures`,
  );
  invariant(
    Object.keys(matrix).length === 1,
    `${label} matrix may define only arch`,
  );

  invariant(Array.isArray(job.steps), `${label} steps must be a list`);
  invariant(job.steps.length === 3, `${label} must contain exactly 3 steps`);
  const download = findUniqueStep(job.steps, "Download tested snap artifact");
  const verify = findUniqueStep(job.steps, "Verify attestation subject");
  const attest = findUniqueStep(
    job.steps,
    "Attest tested Snap build provenance",
  );
  invariant(
    job.steps[0] === download &&
      job.steps[1] === verify &&
      job.steps[2] === attest,
    `${label} must download, verify, then attest the tested artifact`,
  );
  for (const step of job.steps) {
    requireStepExecution(step, `${label} step '${step.name}'`);
  }

  invariant(
    download.uses === DOWNLOAD_ARTIFACT_ACTION,
    `${label} download action must be commit-pinned`,
  );
  const artifactDir = `snap-artifact/${MATRIX_ARCH_EXPRESSION}`;
  const downloadInputs = requireRecord(
    download.with,
    `${label} download inputs`,
  );
  invariant(
    downloadInputs.name === `snap-${MATRIX_ARCH_EXPRESSION}` &&
      downloadInputs.path === artifactDir &&
      Object.keys(downloadInputs).length === 2,
    `${label} must download only the tested architecture artifact`,
  );

  const verifyEnv = requireRecord(verify.env, `${label} verify environment`);
  invariant(
    verifyEnv.ARTIFACT_DIR === artifactDir &&
      verifyEnv.EXPECTED_ARCH === MATRIX_ARCH_EXPRESSION &&
      Object.keys(verifyEnv).length === 2,
    `${label} verification must be bound to the matrix artifact`,
  );
  requireExactScript(
    verify.run,
    [
      "set -euo pipefail",
      `mapfile -t SNAP_FILES < <(find "$ARTIFACT_DIR" -maxdepth 1 -type f -name '*.snap' -print)`,
      `test "\${#SNAP_FILES[@]}" -eq 1`,
      'test -f "$ARTIFACT_DIR/snap-evidence/$EXPECTED_ARCH/SHA256SUMS"',
      '(cd "$ARTIFACT_DIR" && sha256sum --check --strict "snap-evidence/$EXPECTED_ARCH/SHA256SUMS")',
    ],
    `${label} verification step`,
  );

  invariant(
    attest.uses === ATTEST_ACTION,
    `${label} attestation action must be commit-pinned`,
  );
  const attestInputs = requireRecord(
    attest.with,
    `${label} attestation inputs`,
  );
  invariant(
    attestInputs["subject-path"] === `${artifactDir}/*.snap` &&
      Object.keys(attestInputs).length === 1,
    `${label} attestation must cover only the verified architecture artifact`,
  );
}

export function validateSnapWorkflowSource(
  source,
  { expectedBunVersion = "1.3.14" } = {},
) {
  const workflow = parseYamlMapping(source, "Snap workflow");
  const triggers = requireRecord(
    requireOwn(workflow, "on", "Snap workflow"),
    "Snap workflow on",
  );
  for (const eventName of ["push", "pull_request"]) {
    const event = requireRecord(
      requireOwn(triggers, eventName, "Snap workflow on"),
      `Snap ${eventName} trigger`,
    );
    requireExactStringArray(
      requireOwn(event, "branches", `Snap ${eventName} trigger`),
      ["develop"],
      `Snap ${eventName} branches`,
    );
    invariant(
      !Object.hasOwn(event, "paths") && !Object.hasOwn(event, "paths-ignore"),
      `Snap ${eventName} trigger must not path-filter the runtime closure`,
    );
  }
  requireOwn(triggers, "workflow_dispatch", "Snap workflow on");
  const jobs = requireRecord(
    requireOwn(workflow, "jobs", "Snap workflow"),
    "Snap workflow jobs",
  );
  const buildJob = requireRecord(
    requireOwn(jobs, "build-snap", "Snap workflow jobs"),
    "build-snap job",
  );
  validateSnapBuildJob(buildJob, {
    label: "build-snap job",
    expectedBunVersion,
    expectedPrepareScript: EXPECTED_PREPARE_SCRIPT,
    uploadStepName: "Upload snap artifact",
    uploadRetention: 30,
    attestationInBuild: false,
    expectedCheckoutRef: PR_HEAD_OR_TRIGGER_SHA_EXPRESSION,
    expectedSourceRevision: PR_HEAD_OR_TRIGGER_SHA_EXPRESSION,
    allowedExtraSteps: [
      "Free disk space on runner",
      "Normalize runner root ownership for snapd",
    ],
  });
  validateTrustedSnapAttestationJob(
    requireRecord(
      requireOwn(jobs, "attest-snap", "Snap workflow jobs"),
      "attest-snap job",
    ),
  );
}

export function validateSnapPublishWorkflowSource(
  source,
  { kind, expectedBunVersion = "1.3.14" } = {},
) {
  invariant(
    kind === "standalone" || kind === "aggregate",
    "Snap publish workflow kind must be standalone or aggregate",
  );
  const workflow = parseYamlMapping(source, `${kind} Snap publish workflow`);
  const jobs = requireRecord(
    requireOwn(workflow, "jobs", `${kind} Snap publish workflow`),
    `${kind} Snap publish jobs`,
  );
  const jobName = kind === "standalone" ? "build-and-publish" : "publish-snap";
  const buildJob = requireRecord(
    requireOwn(jobs, jobName, `${kind} Snap publish jobs`),
    `${kind} Snap publish job`,
  );
  const versionExpression =
    kind === "standalone"
      ? INPUT_VERSION_EXPRESSION
      : PREPARED_VERSION_EXPRESSION;
  const prepareScript =
    kind === "standalone"
      ? [
          "set -euo pipefail",
          'test -n "$VERSION"',
          '[[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]',
          'case "$CHANNEL" in',
          "edge|beta) SNAP_GRADE=devel ;;",
          "candidate|stable) SNAP_GRADE=stable ;;",
          '*) echo "Unsupported Snap Store channel: $CHANNEL" >&2; exit 1 ;;',
          "esac",
          "mkdir -p snap",
          "cp packages/app-core/packaging/snap/snapcraft.yaml snap/snapcraft.yaml",
          `sed -i "s/^version: .*/version: '${SHELL_VERSION_EXPANSION}'/" snap/snapcraft.yaml`,
          `sed -i "s/^grade: .*/grade: ${SHELL_GRADE_EXPANSION}/" snap/snapcraft.yaml`,
          `grep -Fx "grade: ${SHELL_GRADE_EXPANSION}" snap/snapcraft.yaml`,
          'echo "Snap version: $VERSION"',
          'echo "Snap grade: $SNAP_GRADE for channel $CHANNEL"',
        ]
      : [
          "set -euo pipefail",
          "mkdir -p snap",
          "cp packages/app-core/packaging/snap/snapcraft.yaml snap/snapcraft.yaml",
          'test -n "$VERSION"',
          '[[ "$VERSION" =~ ^[0-9]+\\.[0-9]+\\.[0-9]+([+-][0-9A-Za-z.-]+)?$ ]]',
          'case "$IS_PRERELEASE" in',
          "true) SNAP_GRADE=devel ;;",
          "false) SNAP_GRADE=stable ;;",
          '*) echo "Invalid prerelease state: $IS_PRERELEASE" >&2; exit 1 ;;',
          "esac",
          `sed -i "s/^version: .*/version: '${SHELL_VERSION_EXPANSION}'/" snap/snapcraft.yaml`,
          `sed -i "s/^grade: .*/grade: ${SHELL_GRADE_EXPANSION}/" snap/snapcraft.yaml`,
          `grep -Fx "grade: ${SHELL_GRADE_EXPANSION}" snap/snapcraft.yaml`,
          'echo "Snap version: $VERSION"',
          'echo "Snap grade: $SNAP_GRADE for prerelease=$IS_PRERELEASE"',
        ];
  validateSnapBuildJob(buildJob, {
    label: `${kind} Snap publish job`,
    expectedBunVersion,
    expectedNeeds: kind === "aggregate" ? "prepare" : undefined,
    expectedJobIf: kind === "aggregate" ? "inputs.snap" : undefined,
    expectedPrepareScript: prepareScript,
    expectedPrepareVersionEnv: versionExpression,
    expectedPrepareChannelEnv:
      kind === "standalone" ? INPUT_CHANNEL_EXPRESSION : undefined,
    expectedPreparePrereleaseEnv:
      kind === "aggregate" ? PREPARED_PRERELEASE_EXPRESSION : undefined,
    expectedVersionEnv: versionExpression,
    uploadStepName:
      kind === "standalone"
        ? "Upload snap artifact and evidence"
        : "Upload Snap artifact and evidence",
    uploadRetention: kind === "standalone" ? 30 : 90,
    publish: {
      condition:
        kind === "standalone"
          ? "steps.creds_check.outputs.can_publish == 'true'"
          : "success() && needs.prepare.outputs.snap_store_ready == 'true'",
      release:
        kind === "standalone"
          ? INPUT_CHANNEL_EXPRESSION
          : PREPARED_CHANNEL_EXPRESSION,
    },
    allowedExtraSteps:
      kind === "standalone"
        ? ["Check Snap Store credentials"]
        : ["Normalize runner root ownership for snapd"],
    expectedCheckoutRef:
      kind === "standalone" ? INPUT_TAG_EXPRESSION : undefined,
  });
  const publishStep = findUniqueStep(buildJob.steps, "Publish to Snap Store");
  if (kind === "standalone") {
    invariant(
      !Object.hasOwn(buildJob, "env"),
      "standalone Snap Store credential must not be exposed to the build job",
    );
    invariant(
      requireRecord(publishStep.env, "standalone Snap publish environment")
        .SNAPCRAFT_STORE_CREDENTIALS ===
        STANDALONE_STORE_CREDENTIALS_EXPRESSION,
      "standalone Snap publish step must receive its declared Store credential",
    );
    const credentialCheck = findUniqueStep(
      buildJob.steps,
      "Check Snap Store credentials",
    );
    invariant(
      credentialCheck.id === "creds_check",
      "standalone Snap credential check must expose its result",
    );
    invariant(
      requireRecord(
        credentialCheck.env,
        "standalone Snap credential check environment",
      ).SNAPCRAFT_STORE_CREDENTIALS === STANDALONE_STORE_CREDENTIALS_EXPRESSION,
      "standalone Snap credential check must receive only its declared Store credential",
    );
    const credentialLines = activeScriptLines(
      credentialCheck.run,
      "standalone Snap credential check",
    );
    invariant(
      credentialLines[0] === "set -euo pipefail" &&
        credentialLines.includes(
          'echo "can_publish=false" >> "$GITHUB_OUTPUT"',
        ) &&
        credentialLines.includes('echo "can_publish=true" >> "$GITHUB_OUTPUT"'),
      "standalone Snap credential check must emit both explicit outcomes",
    );
  } else {
    invariant(
      requireRecord(publishStep.env, "aggregate Snap publish environment")
        .SNAPCRAFT_STORE_CREDENTIALS === AGGREGATE_STORE_CREDENTIALS_EXPRESSION,
      "aggregate Snap publish step must receive its declared Store credential",
    );
  }
}

function requireActiveShellLine(lines, expected, label) {
  invariant(lines.includes(expected), `${label} must execute '${expected}'`);
}

function requireActiveShellMatch(lines, pattern, description, label) {
  invariant(
    lines.some((line) => pattern.test(line)),
    `${label} must execute ${description}`,
  );
}

export function validateSnapManifestSource(
  source,
  { expectedBunVersion = "1.3.14", expectedNodeVersion = "24.15.0" } = {},
) {
  const manifest = parseYamlMapping(source, "Snapcraft manifest");
  invariant(
    manifest.base === "core22",
    "Snapcraft must build against the declared core22 base",
  );
  invariant(
    manifest.confinement === "strict",
    "Snapcraft must retain strict confinement",
  );
  invariant(
    manifest.grade === "devel",
    "Snapcraft source manifest must remain development-grade for beta and edge builds",
  );
  const layout = requireRecord(manifest.layout, "Snapcraft layout");
  for (const triplet of ["x86_64-linux-gnu", "aarch64-linux-gnu"]) {
    const libraryPath = `/usr/lib/${triplet}/libatomic.so.1`;
    invariant(
      requireRecord(
        requireOwn(layout, libraryPath, "Snapcraft layout"),
        `Snapcraft ${triplet} libatomic layout`,
      ).symlink === `$SNAP${libraryPath}`,
      `Snapcraft must expose staged libatomic for ${triplet}`,
    );
  }
  invariant(
    Array.isArray(manifest.architectures),
    "Snapcraft architectures must be a list",
  );
  invariant(
    manifest.architectures.length === 2,
    "Snapcraft must declare exactly amd64 and arm64",
  );
  const manifestArchitectures = manifest.architectures.map((entryValue) => {
    const entry = requireRecord(entryValue, "Snapcraft architecture entry");
    requireExactStringArray(
      entry["build-on"],
      entry["build-for"],
      "Snapcraft build-on/build-for",
    );
    invariant(
      entry["build-on"].length === 1,
      "Snapcraft architecture entries must be native builds",
    );
    return entry["build-on"][0];
  });
  requireExactStringArray(
    manifestArchitectures,
    ["amd64", "arm64"],
    "Snapcraft architectures",
  );

  const parts = requireRecord(manifest.parts, "Snapcraft parts");
  const nodeShell = requireRecord(parts.node, "Snapcraft node part")[
    "override-build"
  ];
  invariant(
    typeof nodeShell === "string",
    "Snapcraft node part must define override-build",
  );
  const nodeLines = activeScriptLines(nodeShell, "Snapcraft node build");
  invariant(
    nodeLines[0] === "set -eu",
    "Snapcraft node build must start fail closed",
  );
  requireActiveShellLine(
    nodeLines,
    `NODE_VERSION="${expectedNodeVersion}"`,
    "Snapcraft node build",
  );
  requireActiveShellLine(
    nodeLines,
    `NODE_SHA256="${NODE_SHA256.amd64}"`,
    "Snapcraft node build",
  );
  requireActiveShellLine(
    nodeLines,
    `NODE_SHA256="${NODE_SHA256.arm64}"`,
    "Snapcraft node build",
  );
  requireActiveShellMatch(
    nodeLines,
    /^printf .+\| sha256sum --check --strict$/,
    "a strict SHA-256 verification pipeline",
    "Snapcraft node build",
  );
  requireActiveShellLine(
    nodeLines,
    "curl --fail --location --proto '=https' --tlsv1.2 \\",
    "Snapcraft node build",
  );
  requireActiveShellLine(
    nodeLines,
    NODE_DOWNLOAD_URL_LINE,
    "Snapcraft node build",
  );
  invariant(
    nodeLines.filter((line) => /\b(?:curl|wget)\b/.test(line)).length === 1,
    "Snapcraft node build must perform exactly one verified download",
  );
  invariant(
    nodeLines.filter((line) => /(?:^|\s)NODE_SHA256=/.test(line)).length === 2,
    "Snapcraft node checksum may be assigned only by the two architecture branches",
  );

  const bunShell = requireRecord(parts.bun, "Snapcraft Bun part")[
    "override-build"
  ];
  invariant(
    typeof bunShell === "string",
    "Snapcraft Bun part must define override-build",
  );
  const bunLines = activeScriptLines(bunShell, "Snapcraft Bun build");
  invariant(
    bunLines[0] === "set -eu",
    "Snapcraft Bun build must start fail closed",
  );
  requireActiveShellLine(
    bunLines,
    `BUN_VERSION="${expectedBunVersion}"`,
    "Snapcraft Bun build",
  );
  requireActiveShellLine(
    bunLines,
    `BUN_SHA256="${BUN_SHA256.amd64}"`,
    "Snapcraft Bun build",
  );
  requireActiveShellLine(
    bunLines,
    `BUN_SHA256="${BUN_SHA256.arm64}"`,
    "Snapcraft Bun build",
  );
  requireActiveShellMatch(
    bunLines,
    /^printf .+\| sha256sum --check --strict$/,
    "a strict SHA-256 verification pipeline",
    "Snapcraft Bun build",
  );
  requireActiveShellLine(
    bunLines,
    "curl --fail --location --proto '=https' --tlsv1.2 \\",
    "Snapcraft Bun build",
  );
  requireActiveShellLine(
    bunLines,
    BUN_DOWNLOAD_URL_LINE,
    "Snapcraft Bun build",
  );
  invariant(
    bunLines.filter((line) => /\b(?:curl|wget)\b/.test(line)).length === 1,
    "Snapcraft Bun build must perform exactly one verified download",
  );
  invariant(
    !bunShell.includes("releases/latest"),
    "Snapcraft Bun build must not use a mutable release URL",
  );
  invariant(
    bunLines.filter((line) => /(?:^|\s)BUN_SHA256=/.test(line)).length === 2,
    "Snapcraft Bun checksum may be assigned only by the two architecture branches",
  );

  const appPart = requireRecord(parts["elizaos-app"], "Snapcraft app part");
  invariant(
    appPart.source === ".",
    "Snapcraft app source must be the repository root",
  );
  const appShell = appPart["override-build"];
  invariant(
    typeof appShell === "string",
    "Snapcraft app part must define override-build",
  );
  const activeLines = activeScriptLines(
    appShell,
    "Snapcraft app override-build",
  );
  invariant(
    activeLines[0] === "set -eu",
    "Snapcraft app build must start fail closed",
  );
  const installLines = activeLines.filter((line) =>
    /\bbun\s+install\b/.test(line),
  );
  invariant(
    installLines.length === 1 &&
      installLines[0] === "bun install --frozen-lockfile --ignore-scripts",
    "Snapcraft app build must perform exactly one frozen Bun install",
  );
  const frozenInstallIndex = activeLines.indexOf(
    "bun install --frozen-lockfile --ignore-scripts",
  );
  const frozenClosureBlock = [
    "test -f bun.lock",
    'LOCKFILE_SHA256="$(sha256sum bun.lock)"',
    "bun install --frozen-lockfile --ignore-scripts",
    'test "$(sha256sum bun.lock)" = "$LOCKFILE_SHA256"',
    'test -x "$ROOT_NODE_MODULES_BIN/turbo"',
  ];
  const frozenClosurePrefix = [
    "set -eu",
    'export PATH="$CRAFT_STAGE/bun/bin:$CRAFT_STAGE/node/bin:$PATH"',
    'APP_CORE_DIR="packages/app-core"',
    'PACKAGES_DIR="packages"',
    'APP_CORE_SCRIPTS_DIR="$APP_CORE_DIR/scripts"',
    'RM_PATH_RECURSIVE="packages/scripts/rm-path-recursive.mjs"',
    'ROOT_NODE_MODULES_BIN="node_modules/.bin"',
    "export ELIZAOS_APP_SKIP_LOCAL_UPSTREAMS=1",
    "export SKIP_NATIVE_PLUGINS=1",
    ...frozenClosureBlock,
  ];
  invariant(
    frozenClosurePrefix.every((line, index) => activeLines[index] === line),
    "Snapcraft frozen install must execute at top level before any conditional or workspace rewrite",
  );
  invariant(
    frozenInstallIndex >= 2 &&
      frozenClosureBlock.every(
        (line, index) => activeLines[frozenInstallIndex - 2 + index] === line,
      ),
    "Snapcraft frozen install, lock integrity check, and tool proof must be one contiguous top-level block",
  );
  const pruneIndex = activeLines.findIndex((line) =>
    line.includes('fs.rmSync(path.join("plugins", dir)'),
  );
  invariant(
    frozenInstallIndex >= 0 &&
      pruneIndex >= 0 &&
      frozenInstallIndex < pruneIndex,
    "Snapcraft frozen install must run before the workspace is pruned",
  );

  const runtimeCopyIndex = activeLines.indexOf(
    "node --import tsx packages/app-core/scripts/copy-runtime-node-modules.ts \\",
  );
  const runtimeTypesCleanupIndexes = activeLines
    .map((line, index) =>
      line === 'node "$RM_PATH_RECURSIVE" node_modules/@types' ? index : -1,
    )
    .filter((index) => index >= 0);
  const finalBuildTypesCleanupIndex = activeLines.lastIndexOf(
    'node "$RM_PATH_RECURSIVE" "$SNAP_BUILD_TYPES_DIR"',
  );
  invariant(
    runtimeCopyIndex >= 0 &&
      runtimeTypesCleanupIndexes.length === 1 &&
      runtimeTypesCleanupIndexes[0] > runtimeCopyIndex &&
      finalBuildTypesCleanupIndex > runtimeTypesCleanupIndexes[0],
    "Snapcraft declaration inputs must remain available until the transitive runtime closure is materialized",
  );

  const forbiddenAcquisition = [
    [/\bnpm\s+(?:view|install|ci|add)\b/, "npm acquisition"],
    [/\bnpx\b/, "npx acquisition"],
    [/\bbunx\b/, "bunx acquisition"],
    [/\b(?:curl|wget)\b/, "unverified app dependency download"],
    [
      /install-published-workspace-fallback-deps/,
      "published workspace fallback",
    ],
    [/\brm\b[^\n]*\bbun\.lock\b/, "lockfile deletion"],
  ];
  const activeAppShell = activeLines.join("\n");
  invariant(
    !activeAppShell.includes("ELIZA_RUNTIME_COPY_ALLOW_REGISTRY_FETCH"),
    "Snapcraft app build must not enable registry fallback for runtime copying",
  );
  for (const [pattern, label] of forbiddenAcquisition) {
    invariant(
      !pattern.test(activeAppShell),
      `Snapcraft app build forbids ${label}`,
    );
  }
  invariant(
    !activeLines.some(
      (line) =>
        /(?:\|\||;|\|)\s*(?:true\b|echo\b|:|exit\s+0\b)/.test(line) ||
        /\bset\s+\+e\b/.test(line),
    ),
    "Snapcraft app build must not mask failures with shell fallbacks",
  );

  for (const expectedLine of [
    "test -f bun.lock",
    'LOCKFILE_SHA256="$(sha256sum bun.lock)"',
    'test "$(sha256sum bun.lock)" = "$LOCKFILE_SHA256"',
    'TAILWIND_PACKAGE_JSON="$APP_CORE_DIR/node_modules/tailwindcss/package.json"',
    'test -f "$TAILWIND_PACKAGE_JSON"',
    '"$ROOT_NODE_MODULES_BIN/turbo" run build \\',
  ]) {
    requireActiveShellLine(activeLines, expectedLine, "Snapcraft app build");
  }
}

export function validateInstalledSnapSmokeSource(source) {
  const lines = activeScriptLines(source, "installed Snap smoke script");
  invariant(
    lines[0] === "set -euo pipefail",
    "installed Snap smoke must start fail closed",
  );
  invariant(
    lines.filter((line) => line === "set +e").length === 1,
    "installed Snap smoke may disable errexit only in its annotated teardown",
  );
  invariant(
    !/test\s+"\$\([^\n]*snap run/.test(source),
    "installed Snap smoke must not hide snap run status inside test command substitution",
  );
  invariant(
    !lines.includes("sudo snap connect elizaos-app:network"),
    "installed runtime startup must remain offline",
  );

  requireOrderedLines(
    lines,
    [
      "amd64) EXPECTED_NODE_ARCH=x64 ;;",
      "arm64) EXPECTED_NODE_ARCH=arm64 ;;",
      'EVIDENCE_DIR="$(realpath "$EVIDENCE_DIR")"',
      'if "$@" >"$stdout_file" 2>"$stderr_file"; then',
      "command_status=0",
      "command_status=$?",
      `printf '%s\\n' "$command_status" | tee "$status_file"`,
      'test "$command_status" -eq 0',
      'sudo snap install "$SNAP_PATH" --dangerous',
      "sudo snap disconnect elizaos-app:network",
      "sudo snap disconnect elizaos-app:network-bind",
      'chmod 0555 "$CLEAN_CWD"',
      "run_capture version snap run elizaos-app --version",
      "run_capture help snap run elizaos-app --help",
      "run_capture bundled-node snap run --shell elizaos-app -c '$SNAP/node/bin/node --version'",
      "run_capture bundled-node-arch snap run --shell elizaos-app -c '$SNAP/node/bin/node -p process.arch'",
      "run_capture bundled-bun snap run --shell elizaos-app -c '$SNAP/bun/bin/bun --version'",
      `run_capture unicode-home snap run --shell elizaos-app -c 'UNICODE_HOME="$SNAP_USER_DATA/用户 home"; mkdir -p "$UNICODE_HOME"; HOME="$UNICODE_HOME" "$SNAP/bin/elizaos-app-wrapper" --version'`,
      'test "$VERSION_OUTPUT" = "$EXPECTED_VERSION"',
      'test "$UNICODE_HOME_OUTPUT" = "$EXPECTED_VERSION"',
      'test "$NODE_OUTPUT" = "v24.15.0"',
      'test "$NODE_ARCH_OUTPUT" = "$EXPECTED_NODE_ARCH"',
      'test "$BUN_OUTPUT" = "1.3.14"',
      'sudo snap install "$LIFECYCLE_SNAP" --dangerous',
      'sudo snap install "$SNAP_PATH" --dangerous',
      "sudo snap revert elizaos-app",
      'sudo snap install "$SNAP_PATH" --dangerous',
      "sudo snap disconnect elizaos-app:network",
      "sudo snap disconnect elizaos-app:network-bind",
      "sudo snap connect elizaos-app:network-bind",
      'snap run elizaos-app start >"$RUNTIME_LOG" 2>&1 &',
      'test "$HEALTH_READY" = true',
      "sudo snap remove --purge elizaos-app",
      "printf 'removed\\n' >\"$EVIDENCE_DIR/uninstall.status\"",
    ],
    "installed Snap smoke",
  );
  invariant(
    source.includes("body.ready !== true"),
    "installed Snap health proof must require ready:true",
  );
  invariant(
    source.includes("0.0.1-lifecycle"),
    "installed Snap smoke must label its synthetic rollback fixture truthfully",
  );
}

export function validatePackagingHarnessSource(source) {
  invariant(
    !source.includes('if "$@" >/dev/null 2>&1; then'),
    "packaging harness must not suppress validator diagnostics",
  );
  invariant(
    source.includes('if output="$("$@" 2>&1)"; then') &&
      source.includes("printf '%s\\n' \"$output\" >&2"),
    "packaging harness must replay failed command diagnostics",
  );
  invariant(
    source.includes(
      'check "Snap build and workflow pass semantic contract" node "$SNAP_CONTRACT_VALIDATOR"',
    ),
    "packaging harness must execute the Snap contract validator",
  );
}

export function validatePackagingWorkflowSource(
  source,
  { expectedBunVersion = "1.3.14", expectedNodeVersion = "24.15.0" } = {},
) {
  invariant(
    !source.includes('bun-version: "canary"'),
    "packaging workflow must not use a floating Bun channel",
  );
  const bunInstallLines = source.match(/bun install[^\n]*/g) ?? [];
  invariant(
    bunInstallLines.length > 0 &&
      bunInstallLines.every((line) =>
        line.includes("bun install --frozen-lockfile --ignore-scripts"),
      ),
    "every packaging workflow Bun install must be frozen",
  );
  const workflow = parseYamlMapping(source, "packaging test workflow");
  const triggers = requireRecord(
    requireOwn(workflow, "on", "packaging test workflow"),
    "packaging test triggers",
  );
  const requiredPaths = [
    "packages/app-core/packaging/**",
    "packages/app-core/package.json",
    "packages/app-core/scripts/validate-snap-packaging-contract.mjs",
    "packages/app-core/scripts/validate-snap-packaging-contract.test.mjs",
    ".github/ci-bun-version.json",
    ".github/workflows/snap-build-test.yml",
    ".github/workflows/snap-publish.yml",
    ".github/workflows/publish-packages.yml",
    ".github/workflows/test-packaging.yml",
    "package.json",
    "bun.lock",
  ];
  for (const eventName of ["push", "pull_request"]) {
    const event = requireRecord(
      requireOwn(triggers, eventName, "packaging test triggers"),
      `packaging ${eventName} trigger`,
    );
    requireExactStringArray(
      event.branches,
      ["develop"],
      `packaging ${eventName} branches`,
    );
    invariant(
      Array.isArray(event.paths),
      `packaging ${eventName} paths must be a list`,
    );
    for (const path of requiredPaths) {
      invariant(
        event.paths.includes(path),
        `packaging ${eventName} paths must include ${path}`,
      );
    }
  }

  const jobs = requireRecord(
    requireOwn(workflow, "jobs", "packaging test workflow"),
    "packaging test jobs",
  );
  const validateJob = requireRecord(
    requireOwn(jobs, "validate", "packaging test jobs"),
    "packaging validate job",
  );
  invariant(
    validateJob["runs-on"] === "ubuntu-24.04",
    "packaging validate job must bind to ubuntu-24.04",
  );
  requireNoConditionalOrErrorOverride(validateJob, "packaging validate job");
  invariant(
    !Object.hasOwn(validateJob, "needs"),
    "packaging validate job must not depend on an optional job",
  );
  invariant(
    Array.isArray(validateJob.steps),
    "packaging validate steps must be a list",
  );
  for (const [index, stepValue] of validateJob.steps.entries()) {
    requireStepExecution(
      requireRecord(stepValue, `packaging validate step ${index + 1}`),
      `packaging validate step ${index + 1}`,
    );
  }

  const setupNode = findUniqueStep(validateJob.steps, "Setup Node.js");
  invariant(
    requireRecord(setupNode.with, "packaging Node inputs")["node-version"] ===
      expectedNodeVersion,
    `packaging validator must use Node ${expectedNodeVersion}`,
  );
  const setupBun = findUniqueStep(validateJob.steps, "Setup Bun");
  invariant(
    setupBun.uses === SETUP_BUN_ACTION,
    "packaging Setup Bun action must be commit-pinned",
  );
  invariant(
    requireRecord(setupBun.with, "packaging Bun inputs")["bun-version"] ===
      expectedBunVersion,
    `packaging validator must use Bun ${expectedBunVersion}`,
  );

  const install = findUniqueStep(
    validateJob.steps,
    "Install validation dependencies from the committed lock",
  );
  requireExactScript(
    install.run,
    [
      "set -euo pipefail",
      'LOCKFILE_SHA256="$(sha256sum bun.lock)"',
      "bun install --frozen-lockfile --ignore-scripts",
      'test "$(sha256sum bun.lock)" = "$LOCKFILE_SHA256"',
      "python -m pip install 'pyyaml==6.0.3' 'build==1.3.0' 'twine==6.2.0'",
    ],
    "packaging dependency install",
  );

  const contracts = findUniqueStep(
    validateJob.steps,
    "Validate Snap packaging contracts",
  );
  requireExactScript(
    contracts.run,
    [
      "set -euo pipefail",
      "node packages/app-core/scripts/validate-snap-packaging-contract.mjs",
      "node packages/scripts/run-vitest.mjs run packages/app-core/scripts/validate-snap-packaging-contract.test.mjs",
    ],
    "packaging Snap contract step",
  );
  const suite = findUniqueStep(
    validateJob.steps,
    "Run packaging validation suite",
  );
  invariant(
    install &&
      validateJob.steps.indexOf(install) <
        validateJob.steps.indexOf(contracts) &&
      validateJob.steps.indexOf(contracts) < validateJob.steps.indexOf(suite),
    "packaging frozen install, contract tests, and full suite must execute in order",
  );
}

export function validateSnapPackagingFiles({
  workflowPath = DEFAULT_WORKFLOW_PATH,
  standalonePublishPath = DEFAULT_STANDALONE_PUBLISH_PATH,
  aggregatePublishPath = DEFAULT_AGGREGATE_PUBLISH_PATH,
  packagingWorkflowPath = DEFAULT_PACKAGING_WORKFLOW_PATH,
  manifestPath = DEFAULT_MANIFEST_PATH,
  installedSmokePath = DEFAULT_INSTALLED_SMOKE_PATH,
  packagingHarnessPath = DEFAULT_PACKAGING_HARNESS_PATH,
} = {}) {
  const ciBunVersion = JSON.parse(
    readFileSync(CI_BUN_VERSION_PATH, "utf8"),
  ).version;
  const rootManifest = JSON.parse(readFileSync(ROOT_MANIFEST_PATH, "utf8"));
  invariant(
    typeof ciBunVersion === "string" && ciBunVersion,
    "CI Bun pin is missing",
  );
  invariant(
    typeof rootManifest.engines?.node === "string" && rootManifest.engines.node,
    "root Node engine pin is missing",
  );
  validateSnapWorkflowSource(readFileSync(workflowPath, "utf8"), {
    expectedBunVersion: ciBunVersion,
  });
  validateSnapPublishWorkflowSource(
    readFileSync(standalonePublishPath, "utf8"),
    {
      kind: "standalone",
      expectedBunVersion: ciBunVersion,
    },
  );
  validateSnapPublishWorkflowSource(
    readFileSync(aggregatePublishPath, "utf8"),
    {
      kind: "aggregate",
      expectedBunVersion: ciBunVersion,
    },
  );
  validatePackagingWorkflowSource(readFileSync(packagingWorkflowPath, "utf8"), {
    expectedBunVersion: ciBunVersion,
    expectedNodeVersion: rootManifest.engines.node,
  });
  validateSnapManifestSource(readFileSync(manifestPath, "utf8"), {
    expectedBunVersion: ciBunVersion,
    expectedNodeVersion: rootManifest.engines.node,
  });
  validateInstalledSnapSmokeSource(readFileSync(installedSmokePath, "utf8"));
  validatePackagingHarnessSource(readFileSync(packagingHarnessPath, "utf8"));
  return {
    bunVersion: ciBunVersion,
    nodeVersion: rootManifest.engines.node,
    workflowPath,
    standalonePublishPath,
    aggregatePublishPath,
    packagingWorkflowPath,
    manifestPath,
    installedSmokePath,
    packagingHarnessPath,
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = validateSnapPackagingFiles();
    process.stdout.write(
      `Snap packaging contract passed (Bun ${result.bunVersion}, Node ${result.nodeVersion}, amd64 + arm64 blocking).\n`,
    );
  } catch (error) {
    // error-policy:J1 CLI boundary reports one actionable validation failure.
    process.stderr.write(
      `Snap packaging contract failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
