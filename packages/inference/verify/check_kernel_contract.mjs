#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const inferenceRoot = path.resolve(here, "..");
const repoRoot = path.resolve(inferenceRoot, "../..");
const contractPath = path.join(here, "kernel-contract.json");
const buildScriptPath = path.join(
  repoRoot,
  "packages/app-core/scripts/build-llama-cpp-dflash.mjs",
);
const manifestSchemaPath = path.join(
  repoRoot,
  "packages/app-core/src/services/local-inference/manifest/eliza-1.manifest.v1.json",
);
const metalDispatchEvidencePath = path.join(
  here,
  "metal-runtime-dispatch-evidence.json",
);

const errors = [];

function fail(message) {
  errors.push(message);
}

function readText(absPath) {
  return fs.readFileSync(absPath, "utf8");
}

function readJson(absPath) {
  return JSON.parse(readText(absPath));
}

function relFromInference(relPath) {
  return path.join(inferenceRoot, relPath);
}

function listEq(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sortedUnique(values) {
  return Array.from(new Set(values)).sort();
}

function findKernelEnum(node) {
  if (!node || typeof node !== "object") return null;
  if (
    Array.isArray(node.enum) &&
    node.enum.includes("turboquant_q3") &&
    node.enum.includes("dflash")
  ) {
    return node.enum;
  }
  for (const value of Object.values(node)) {
    const found = findKernelEnum(value);
    if (found) return found;
  }
  return null;
}

function extractStringArrayAfter(source, marker, label) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) {
    fail(`could not find ${label} marker: ${marker}`);
    return [];
  }
  const start = source.indexOf("[", markerIndex);
  if (start === -1) {
    fail(`could not find ${label} array start`);
    return [];
  }
  const end = source.indexOf("];", start);
  if (end === -1) {
    fail(`could not find ${label} array end`);
    return [];
  }
  const body = source.slice(start, end + 1);
  return Array.from(body.matchAll(/"([^"]+)"/g), (m) => m[1]);
}

function targetBody(makefile, targetName) {
  const marker = `${targetName}:`;
  const start = makefile.indexOf(marker);
  if (start === -1) {
    fail(`Makefile missing target ${targetName}`);
    return "";
  }
  const next = makefile.slice(start + marker.length).search(/\n[a-zA-Z0-9_.-]+:/);
  return next === -1
    ? makefile.slice(start)
    : makefile.slice(start, start + marker.length + next);
}

function parseArgs(argv) {
  const manifests = [];
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--manifest") {
      if (!argv[i + 1]) {
        fail("--manifest requires a path");
        break;
      }
      manifests.push(path.resolve(argv[++i]));
    } else {
      fail(`unknown argument: ${argv[i]}`);
    }
  }
  return { manifests };
}

const args = parseArgs(process.argv);
const contract = readJson(contractPath);
const makefile = readText(path.join(here, "Makefile"));
const buildScript = readText(buildScriptPath);
const manifestSchema = readJson(manifestSchemaPath);
const metalDispatchEvidence = readJson(metalDispatchEvidencePath);

const allowedStatuses = new Set([
  "blocked",
  "compile-only",
  "needs-hardware",
  "needs-runtime-smoke",
  "partial-qjl-only",
  "reference-only",
  "runtime-ready",
  "standalone-verified",
  "symbol-shipped",
  "verified",
]);

const metalEvidenceKernels =
  metalDispatchEvidence && typeof metalDispatchEvidence === "object"
    ? metalDispatchEvidence.kernels || {}
    : {};

if (metalDispatchEvidence.backend !== "metal") {
  fail(`metal dispatch evidence backend must be "metal"`);
}

// 1. Manifest kernel names are the app-core schema names, not shader names.
const schemaKernelEnum = findKernelEnum(manifestSchema);
if (!schemaKernelEnum) {
  fail(`could not find manifest kernel enum in ${manifestSchemaPath}`);
} else if (!listEq(sortedUnique(contract.manifestKernelNames), sortedUnique(schemaKernelEnum))) {
  fail(
    `manifest kernel enum drift: contract=${sortedUnique(contract.manifestKernelNames).join(",")} schema=${sortedUnique(schemaKernelEnum).join(",")}`,
  );
}

const kernelIds = new Set();
const mappedManifestNames = [];
const mappedRuntimeKeys = [];

for (const kernel of contract.kernels) {
  if (kernelIds.has(kernel.id)) fail(`duplicate kernel id: ${kernel.id}`);
  kernelIds.add(kernel.id);

  mappedManifestNames.push(...kernel.manifestKernelNames);
  mappedRuntimeKeys.push(...kernel.runtimeCapabilityKeys);

  for (const name of kernel.manifestKernelNames) {
    if (!contract.manifestKernelNames.includes(name)) {
      fail(`${kernel.id}: unknown manifest kernel alias ${name}`);
    }
  }
  for (const key of kernel.runtimeCapabilityKeys) {
    if (!contract.requiredRuntimeCapabilityKeys.includes(key)) {
      fail(`${kernel.id}: runtime key ${key} is not in requiredRuntimeCapabilityKeys`);
    }
  }

  for (const [backend, status] of Object.entries(kernel.runtimeStatus || {})) {
    if (!allowedStatuses.has(status)) {
      fail(`${kernel.id}: invalid runtimeStatus.${backend}=${status}`);
    }
  }

  for (const fixture of kernel.fixtures || []) {
    const fixturePath = relFromInference(fixture.path);
    if (!fs.existsSync(fixturePath)) {
      fail(`${kernel.id}: missing fixture ${fixture.path}`);
      continue;
    }
    const data = readJson(fixturePath);
    if (data.kernel !== fixture.kernelField) {
      fail(`${kernel.id}: ${fixture.path} kernel field ${data.kernel} != ${fixture.kernelField}`);
    }
    for (const field of fixture.requiredFields || []) {
      if (!(field in data)) fail(`${kernel.id}: ${fixture.path} missing ${field}`);
    }
    if (!Array.isArray(data.expected_scores) || data.expected_scores.length === 0) {
      fail(`${kernel.id}: ${fixture.path} expected_scores must be non-empty`);
    }
  }

  if (kernel.metal) {
    const metalPath = relFromInference(kernel.metal.source);
    if (!fs.existsSync(metalPath)) {
      fail(`${kernel.id}: missing Metal source ${kernel.metal.source}`);
    } else {
      const metalSource = readText(metalPath);
      if (!metalSource.includes(kernel.metal.verifySymbol)) {
        fail(`${kernel.id}: ${kernel.metal.source} missing ${kernel.metal.verifySymbol}`);
      }
      if (
        kernel.metal.multiBlockSymbol &&
        !metalSource.includes(kernel.metal.multiBlockSymbol)
      ) {
        fail(`${kernel.id}: ${kernel.metal.source} missing ${kernel.metal.multiBlockSymbol}`);
      }
    }

    const evidence = metalEvidenceKernels[kernel.id];
    if (!evidence) {
      fail(`${kernel.id}: missing Metal runtime dispatch evidence entry`);
    } else {
      const runtimeKeys = kernel.runtimeCapabilityKeys || [];
      if (!runtimeKeys.includes(evidence.runtimeCapabilityKey)) {
        fail(
          `${kernel.id}: Metal evidence runtimeCapabilityKey=${evidence.runtimeCapabilityKey} not in ${runtimeKeys.join(",")}`,
        );
      }
      const metalStatus = kernel.runtimeStatus?.metal;
      if (metalStatus === "runtime-ready" && evidence.runtimeReady !== true) {
        fail(`${kernel.id}: contract says Metal runtime-ready but evidence.runtimeReady is not true`);
      }
      if (evidence.runtimeReady === true && metalStatus !== "runtime-ready") {
        fail(`${kernel.id}: Metal evidence is runtime-ready but contract status is ${metalStatus}`);
      }
      if (evidence.runtimeReady === true) {
        if (typeof evidence.smokeTarget !== "string" || evidence.smokeTarget.length === 0) {
          fail(`${kernel.id}: runtime-ready Metal evidence requires smokeTarget`);
        } else if (!targetBody(makefile, evidence.smokeTarget)) {
          fail(`${kernel.id}: Metal evidence smokeTarget ${evidence.smokeTarget} missing from Makefile`);
        }
        if (typeof evidence.maxDiff !== "number" || !Number.isFinite(evidence.maxDiff)) {
          fail(`${kernel.id}: runtime-ready Metal evidence requires numeric maxDiff`);
        }
      } else if (metalStatus === "runtime-ready") {
        fail(`${kernel.id}: non-runtime-ready Metal evidence cannot satisfy runtime-ready status`);
      }
    }
  }

  if (kernel.vulkan) {
    if (!fs.existsSync(relFromInference(kernel.vulkan.source))) {
      fail(`${kernel.id}: missing Vulkan source ${kernel.vulkan.source}`);
    }
  }
}

if (!listEq(sortedUnique(mappedManifestNames), sortedUnique(contract.manifestKernelNames))) {
  fail(
    `manifest alias coverage mismatch: mapped=${sortedUnique(mappedManifestNames).join(",")} contract=${sortedUnique(contract.manifestKernelNames).join(",")}`,
  );
}

if (!listEq(sortedUnique(mappedRuntimeKeys), sortedUnique(contract.requiredRuntimeCapabilityKeys))) {
  fail(
    `runtime capability coverage mismatch: mapped=${sortedUnique(mappedRuntimeKeys).join(",")} required=${sortedUnique(contract.requiredRuntimeCapabilityKeys).join(",")}`,
  );
}

// 2. Build-script capability gate must stay aligned with the inference contract.
const requiredMarker = "function requiredKernelsMissing";
const requiredCapabilityKeys = extractStringArrayAfter(
  buildScript.slice(buildScript.indexOf(requiredMarker)),
  "const required",
  "requiredKernelsMissing required",
);
if (
  !listEq(
    sortedUnique(requiredCapabilityKeys),
    sortedUnique(contract.requiredRuntimeCapabilityKeys),
  )
) {
  fail(
    `build required kernel keys drift: build=${sortedUnique(requiredCapabilityKeys).join(",")} contract=${sortedUnique(contract.requiredRuntimeCapabilityKeys).join(",")}`,
  );
}

// 2b. Metal dispatch-ready capability bits must not be satisfied by shipped
// symbols. The build script intentionally forces every non-runtime-ready Metal
// kernel false until the evidence file records a numeric built-fork graph
// dispatch smoke.
const metalHonestyMarker = "Honesty gate: Metal/Vulkan standalone shaders";
const metalHonestyIndex = buildScript.indexOf(metalHonestyMarker);
const metalProbeMarker = 'if (backend === "metal")';
const metalProbeIndex =
  metalHonestyIndex === -1
    ? -1
    : buildScript.indexOf(metalProbeMarker, metalHonestyIndex);
if (metalProbeIndex === -1) {
  fail("build script missing Metal honesty gate in probeKernels()");
} else {
  const metalProbeBody = buildScript.slice(
    metalProbeIndex,
    buildScript.indexOf("} else if (backend === \"vulkan\")", metalProbeIndex),
  );
  for (const kernel of contract.kernels) {
    if (!kernel.metal) continue;
    const evidence = metalEvidenceKernels[kernel.id];
    const metalStatus = kernel.runtimeStatus?.metal;
    for (const key of kernel.runtimeCapabilityKeys || []) {
      if (evidence?.runtimeReady === true || metalStatus === "runtime-ready") {
        continue;
      }
      if (!metalProbeBody.includes(`kernels.${key} = false`)) {
        fail(`${kernel.id}: build script must force Metal kernels.${key}=false until runtime dispatch evidence is ready`);
      }
    }
  }
}

// 3. Every app-core build target must have an explicit platform verification gate.
const supportedTargets = extractStringArrayAfter(
  buildScript,
  "const SUPPORTED_TARGETS",
  "SUPPORTED_TARGETS",
);
const contractTargets = Object.keys(contract.platformTargets || {});
const missingTargetGates = supportedTargets.filter((t) => !contractTargets.includes(t));
const extraTargetGates = contractTargets.filter((t) => !supportedTargets.includes(t));
if (missingTargetGates.length) {
  fail(`platformTargets missing build target(s): ${missingTargetGates.join(", ")}`);
}
if (extraTargetGates.length) {
  fail(`platformTargets has stale target(s): ${extraTargetGates.join(", ")}`);
}
for (const [target, gate] of Object.entries(contract.platformTargets || {})) {
  for (const field of ["kernelVerification", "runtimeDispatch", "deviceRun"]) {
    if (!allowedStatuses.has(gate[field])) {
      fail(`${target}: invalid ${field}=${gate[field]}`);
    }
  }
  if (typeof gate.nextGate !== "string" || gate.nextGate.trim().length < 8) {
    fail(`${target}: nextGate must describe the next verification action`);
  }
}

// 4. Makefile targets must actually run the declared fixtures.
const metalVerifyBody = targetBody(makefile, "metal-verify");
const metalMultiblockBody = targetBody(makefile, "metal-verify-multiblock");
const vulkanVerifyBody = targetBody(makefile, "vulkan-verify");
const cudaVerifyBody = targetBody(makefile, "cuda-verify");

for (const kernel of contract.kernels) {
  for (const fixture of kernel.fixtures || []) {
    const fixtureRef = fixture.path.replace(/^verify\//, "");
    if (kernel.metal) {
      if (!metalVerifyBody.includes(fixtureRef)) {
        fail(`metal-verify does not cover ${fixture.path}`);
      }
      if (!metalVerifyBody.includes(kernel.metal.verifySymbol)) {
        fail(`metal-verify does not invoke ${kernel.metal.verifySymbol}`);
      }
      if (
        kernel.metal.multiBlockSymbol &&
        !metalMultiblockBody.includes(kernel.metal.multiBlockSymbol)
      ) {
        fail(`metal-verify-multiblock does not invoke ${kernel.metal.multiBlockSymbol}`);
      }
    }
    if (kernel.vulkan && !vulkanVerifyBody.includes(fixtureRef)) {
      fail(`vulkan-verify does not cover ${fixture.path}`);
    }
    if (kernel.cuda?.fixtureGate && !cudaVerifyBody.includes(fixtureRef)) {
      fail(`cuda-verify does not cover ${fixture.path}`);
    }
  }
}

// 5. Report pointers should stay real, otherwise the ledger becomes unauditable.
for (const report of contract.latestReports || []) {
  if (!fs.existsSync(relFromInference(report))) {
    fail(`latestReports entry does not exist: ${report}`);
  }
}

// 6. Optional bundle manifest validation for release-candidate artifacts.
for (const manifestPath of args.manifests) {
  const manifest = readJson(manifestPath);
  const declared = [
    ...((manifest.kernels && manifest.kernels.required) || []),
    ...((manifest.kernels && manifest.kernels.optional) || []),
  ];
  for (const name of declared) {
    if (!contract.manifestKernelNames.includes(name)) {
      fail(`${manifestPath}: unknown manifest kernel name ${name}`);
    }
  }
}

if (errors.length) {
  console.error("[kernel-contract] FAIL");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `[kernel-contract] OK kernels=${contract.kernels.length} targets=${supportedTargets.length} manifestNames=${contract.manifestKernelNames.length}`,
);
