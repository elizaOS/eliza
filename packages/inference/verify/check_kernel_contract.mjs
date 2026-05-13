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
const vulkanDispatchEvidencePath = path.join(
  here,
  "vulkan-runtime-dispatch-evidence.json",
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

function flattenRuntimeEvidenceKernels(evidence) {
  const kernels = {};
  if (!evidence || typeof evidence !== "object") return kernels;

  if (evidence.kernels && typeof evidence.kernels === "object") {
    Object.assign(kernels, evidence.kernels);
  }

  if (evidence.targets && typeof evidence.targets === "object") {
    for (const [target, targetEvidence] of Object.entries(evidence.targets)) {
      if (!targetEvidence?.kernels || typeof targetEvidence.kernels !== "object") {
        continue;
      }
      for (const [id, kernelEvidence] of Object.entries(targetEvidence.kernels)) {
        const normalized =
          id === "fused_attn_qjl_tbq" || id === "fused_attn_qjl_polar"
            ? "fusedAttn"
            : id;
        if (kernels[normalized]?.runtimeReady === true) continue;
        kernels[normalized] = {
          ...kernelEvidence,
          ...(normalized === "fusedAttn" && !kernelEvidence.capabilityKey
            ? { capabilityKey: "fused_attn" }
            : {}),
          target,
        };
      }
    }
  }

  return kernels;
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
const vulkanDispatchEvidence = readJson(vulkanDispatchEvidencePath);

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
  flattenRuntimeEvidenceKernels(metalDispatchEvidence);
const vulkanEvidenceKernels =
  flattenRuntimeEvidenceKernels(vulkanDispatchEvidence);

if (metalDispatchEvidence.backend !== "metal") {
  fail(`metal dispatch evidence backend must be "metal"`);
}
if (vulkanDispatchEvidence.backend !== "vulkan") {
  fail(`vulkan dispatch evidence backend must be "vulkan"`);
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
    const evidence = vulkanEvidenceKernels[kernel.id];
    if (!evidence) {
      fail(`${kernel.id}: missing Vulkan runtime dispatch evidence entry`);
    } else {
      const runtimeKeys = kernel.runtimeCapabilityKeys || [];
      if (!runtimeKeys.includes(evidence.runtimeCapabilityKey)) {
        fail(
          `${kernel.id}: Vulkan evidence runtimeCapabilityKey=${evidence.runtimeCapabilityKey} not in ${runtimeKeys.join(",")}`,
        );
      }
      const vulkanStatus = kernel.runtimeStatus?.vulkan;
      if (vulkanStatus === "runtime-ready" && evidence.runtimeReady !== true) {
        fail(`${kernel.id}: contract says Vulkan runtime-ready but evidence.runtimeReady is not true`);
      }
      if (evidence.runtimeReady === true && vulkanStatus !== "runtime-ready") {
        fail(`${kernel.id}: Vulkan evidence is runtime-ready but contract status is ${vulkanStatus}`);
      }
      if (evidence.runtimeReady === true) {
        if (typeof evidence.smokeTarget !== "string" || evidence.smokeTarget.length === 0) {
          fail(`${kernel.id}: runtime-ready Vulkan evidence requires smokeTarget`);
        } else if (!targetBody(makefile, evidence.smokeTarget)) {
          fail(`${kernel.id}: Vulkan evidence smokeTarget ${evidence.smokeTarget} missing from Makefile`);
        }
        if (typeof evidence.maxDiff !== "number" || !Number.isFinite(evidence.maxDiff)) {
          fail(`${kernel.id}: runtime-ready Vulkan evidence requires numeric maxDiff`);
        }
      }
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
      const evidenceDriven = metalProbeBody.includes(
        `kernels.${key} = metalCapabilityRuntimeReady(`,
      );
      const hardForcedFalse = metalProbeBody.includes(`kernels.${key} = false`);
      if (evidence?.runtimeReady === true || metalStatus === "runtime-ready") {
        if (!evidenceDriven) {
          fail(`${kernel.id}: build script must derive Metal kernels.${key} from runtime dispatch evidence`);
        }
        if (hardForcedFalse) {
          fail(`${kernel.id}: build script must not force runtime-ready Metal kernels.${key}=false`);
        }
        continue;
      }
      if (evidenceDriven) {
        continue;
      }
      if (!hardForcedFalse) {
        fail(`${kernel.id}: build script must force or evidence-gate Metal kernels.${key}=false until runtime dispatch evidence is ready`);
      }
    }
  }
}

const vulkanProbeMarker = 'if (backend === "vulkan")';
const vulkanProbeIndex =
  metalHonestyIndex === -1
    ? -1
    : buildScript.indexOf(vulkanProbeMarker, metalHonestyIndex);
if (vulkanProbeIndex === -1) {
  fail("build script missing Vulkan honesty gate in probeKernels()");
} else {
  const vulkanProbeBody = buildScript.slice(
    vulkanProbeIndex,
    buildScript.indexOf("return kernels;", vulkanProbeIndex),
  );
  if (!buildScript.includes("function readVulkanRuntimeDispatchEvidence")) {
    fail("build script must load Vulkan runtime-dispatch evidence");
  }
  for (const kernel of contract.kernels) {
    if (!kernel.vulkan) continue;
    const evidence = vulkanEvidenceKernels[kernel.id];
    const vulkanStatus = kernel.runtimeStatus?.vulkan;
    for (const key of kernel.runtimeCapabilityKeys || []) {
      const evidenceDriven = vulkanProbeBody.includes(
        `kernels.${key} = vulkanCapabilityRuntimeReady(`,
      );
      const hardForcedFalse = vulkanProbeBody.includes(`kernels.${key} = false`);
      if (evidence?.runtimeReady === true || vulkanStatus === "runtime-ready") {
        if (!evidenceDriven) {
          fail(`${kernel.id}: build script must derive Vulkan kernels.${key} from runtime dispatch evidence`);
        }
        if (hardForcedFalse) {
          fail(`${kernel.id}: build script must not force runtime-ready Vulkan kernels.${key}=false`);
        }
        continue;
      }
      if (evidenceDriven) {
        continue;
      }
      if (!hardForcedFalse) {
        fail(`${kernel.id}: build script must force or evidence-gate Vulkan kernels.${key}=false until runtime dispatch evidence is ready`);
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

// 3b. Runtime smoke declarations must point at real Makefile/script/source
// gates. These are allowed to be "blocked" or "needs-hardware"; the contract
// only requires the gate to exist and to cover the canonical fixtures so a
// future pass cannot be replaced by a softer symbol-only audit.
for (const [name, smoke] of Object.entries(contract.runtimeSmoke || {})) {
  if (!smoke || typeof smoke !== "object") {
    fail(`runtimeSmoke.${name}: must be an object`);
    continue;
  }
  if (!allowedStatuses.has(smoke.status)) {
    fail(`runtimeSmoke.${name}: invalid status=${smoke.status}`);
  }
  if (typeof smoke.makeTarget !== "string" || smoke.makeTarget.length === 0) {
    fail(`runtimeSmoke.${name}: missing makeTarget`);
  } else {
    const body = targetBody(makefile, smoke.makeTarget);
    if (!body) fail(`runtimeSmoke.${name}: Makefile target ${smoke.makeTarget} has empty body`);
  }
  for (const field of ["source", "script"]) {
    if (smoke[field] && !fs.existsSync(relFromInference(smoke[field]))) {
      fail(`runtimeSmoke.${name}: missing ${field} ${smoke[field]}`);
    }
  }
  for (const fixture of smoke.fixtures || []) {
    const fixturePath = relFromInference(fixture);
    if (!fs.existsSync(fixturePath)) {
      fail(`runtimeSmoke.${name}: missing fixture ${fixture}`);
      continue;
    }
    const haystacks = [];
    if (smoke.script && fs.existsSync(relFromInference(smoke.script))) {
      haystacks.push(readText(relFromInference(smoke.script)));
    }
    if (smoke.makeTarget) haystacks.push(targetBody(makefile, smoke.makeTarget));
    const fixtureRef = fixture.replace(/^verify\/fixtures\//, "");
    if (
      haystacks.length > 0 &&
      !haystacks.some((haystack) => haystack.includes(fixtureRef))
    ) {
      fail(`runtimeSmoke.${name}: ${fixture} is declared but not referenced by its smoke gate`);
    }
  }
}

// 3c. Fused-attention capability: fixtures must exist with the right kernel
// field and shape, the contract docs must be real, and the per-backend verify
// targets must exist in the Makefile. The fused op is an optimization layered
// on the existing five kernels — it deliberately is NOT in
// requiredRuntimeCapabilityKeys / manifestKernelNames until a backend reports a
// runtime-ready fused smoke, so it must not leak into those coverage sets.
const fusedAttn = contract.fusedAttn;
if (!fusedAttn || typeof fusedAttn !== "object") {
  fail("contract missing fusedAttn section");
} else {
  if (fusedAttn.capabilityKey !== "fused_attn") {
    fail(`fusedAttn.capabilityKey must be "fused_attn", got ${fusedAttn.capabilityKey}`);
  }
  if (contract.requiredRuntimeCapabilityKeys.includes(fusedAttn.capabilityKey)) {
    fail("fused_attn must not be in requiredRuntimeCapabilityKeys until a backend verifies a fused dispatch");
  }
  if (contract.manifestKernelNames.includes(fusedAttn.capabilityKey)) {
    fail("fused_attn must not be a manifestKernelName until a backend verifies a fused dispatch");
  }
  for (const doc of fusedAttn.contractDocs || []) {
    if (!fs.existsSync(relFromInference(doc))) {
      fail(`fusedAttn.contractDocs entry does not exist: ${doc}`);
    }
  }
  for (const fixture of fusedAttn.fixtures || []) {
    const fixturePath = relFromInference(fixture.path);
    if (!fs.existsSync(fixturePath)) {
      fail(`fusedAttn: missing fixture ${fixture.path}`);
      continue;
    }
    const data = readJson(fixturePath);
    if (data.kernel !== fixture.kernelField) {
      fail(`fusedAttn: ${fixture.path} kernel field ${data.kernel} != ${fixture.kernelField}`);
    }
    for (const field of fixture.requiredFields || []) {
      if (!(field in data)) fail(`fusedAttn: ${fixture.path} missing ${field}`);
    }
    if (fixture.shape === "cases") {
      if (!Array.isArray(data.cases) || data.cases.length === 0) {
        fail(`fusedAttn: ${fixture.path} cases must be a non-empty array`);
      } else {
        for (const [i, c] of data.cases.entries()) {
          for (const field of fixture.caseRequiredFields || []) {
            if (!(field in c)) fail(`fusedAttn: ${fixture.path} cases[${i}] missing ${field}`);
          }
          if (!Array.isArray(c.expected_out) || c.expected_out.length === 0) {
            fail(`fusedAttn: ${fixture.path} cases[${i}].expected_out must be non-empty`);
          }
        }
      }
    } else if (fixture.shape === "scores") {
      if (!Array.isArray(data.expected_scores) || data.expected_scores.length === 0) {
        fail(`fusedAttn: ${fixture.path} expected_scores must be non-empty`);
      }
    } else {
      fail(`fusedAttn: ${fixture.path} unknown shape ${fixture.shape}`);
    }
  }
  for (const [backend, target] of Object.entries(fusedAttn.verifyTargets || {})) {
    if (!targetBody(makefile, target)) {
      fail(`fusedAttn.verifyTargets.${backend} target ${target} missing or empty in Makefile`);
    }
  }
  if (fusedAttn.selfTest && !targetBody(makefile, fusedAttn.selfTest.makeTarget)) {
    fail(`fusedAttn.selfTest.makeTarget ${fusedAttn.selfTest?.makeTarget} missing from Makefile`);
  }
  // A fusedAttn backend may be marked runtime-ready ONLY when the matching
  // per-backend dispatch evidence file carries a `fusedAttn` entry with
  // runtimeReady:true + a Makefile-resident smokeTarget + numeric maxDiff
  // (the same gate the per-kernel vulkan/metal evidence checks apply). This
  // does NOT promote fused_attn into requiredRuntimeCapabilityKeys /
  // manifestKernelNames — the guards above keep it out (AGENTS.md §3: an
  // optimization on top of the five required kernels, not a required kernel).
  const fusedAttnEvidenceByBackend = {
    metal: metalEvidenceKernels.fusedAttn,
    vulkan: vulkanEvidenceKernels.fusedAttn,
  };
  for (const [backend, status] of Object.entries(fusedAttn.runtimeStatus || {})) {
    if (!allowedStatuses.has(status)) {
      fail(`fusedAttn.runtimeStatus.${backend}=${status} is not an allowed status`);
    }
    if (status === "runtime-ready") {
      const evidence = fusedAttnEvidenceByBackend[backend];
      if (!evidence) {
        fail(`fusedAttn.runtimeStatus.${backend}=runtime-ready requires a fusedAttn entry in the ${backend} runtime dispatch evidence`);
      } else {
        if (evidence.runtimeReady !== true) {
          fail(`fusedAttn ${backend} evidence must have runtimeReady:true to satisfy runtime-ready`);
        }
        if (evidence.capabilityKey !== fusedAttn.capabilityKey) {
          fail(`fusedAttn ${backend} evidence capabilityKey=${evidence.capabilityKey} != ${fusedAttn.capabilityKey}`);
        }
        if (typeof evidence.smokeTarget !== "string" || !targetBody(makefile, evidence.smokeTarget)) {
          fail(`fusedAttn ${backend} evidence requires a smokeTarget that exists in the Makefile`);
        }
        if (typeof evidence.maxDiff !== "number" || !Number.isFinite(evidence.maxDiff)) {
          fail(`fusedAttn ${backend} evidence requires numeric maxDiff`);
        }
      }
    } else {
      // A non-runtime-ready status must not have stale runtime-ready evidence.
      const evidence = fusedAttnEvidenceByBackend[backend];
      if (evidence && evidence.runtimeReady === true) {
        fail(`fusedAttn ${backend} evidence is runtimeReady:true but contract status is ${status}`);
      }
    }
  }
  if (typeof fusedAttn.nextGate !== "string" || fusedAttn.nextGate.trim().length < 8) {
    fail("fusedAttn.nextGate must describe the next verification action");
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
