#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const INVENTORY_PATH = path.join(HERE, "cuda-continuity-inventory.json");
const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const FORBIDDEN_LOG_SIGNALS = [
  /fallback(?:-| )to(?:-| )cpu/i,
  /using cpu backend/i,
  /cuda(?: device)? unavailable/i,
  /out of memory/i,
  /cuda error/i,
  /corrupt(?:ed|ion)/i,
  /SKIP(?:PED)?.*(?:gpu|cuda|kernel|graph)/i,
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function capture(command, args = []) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function sha256(file) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(file));
  return hash.digest("hex");
}

function parseVersion(text, pattern, label) {
  const value = text.match(pattern)?.[1];
  if (!value) throw new Error(`could not parse ${label}`);
  return value;
}

function inferProfile(name, computeCapability) {
  const normalized = name.toLowerCase();
  if (normalized.includes("3090")) return "rtx-3090-sm86";
  if (normalized.includes("4090")) return "rtx-4090-sm89";
  if (normalized.includes("5090")) return "rtx-5090-sm120";
  if (normalized.includes("h200")) return "h200-sm90";
  return `unlisted-sm${computeCapability.replace(".", "")}`;
}

export function collectProbe({ expectedHead = process.env.GITHUB_SHA } = {}) {
  const head = capture("git", ["rev-parse", "HEAD"]);
  const nativeSourceCommit = capture("git", [
    "rev-parse",
    "HEAD:plugins/plugin-local-inference/native/llama.cpp",
  ]);
  const nvidiaRows = capture("nvidia-smi", [
    "--query-gpu=index,name,uuid,driver_version,compute_cap,memory.total",
    "--format=csv,noheader,nounits",
  ]);
  if (!nvidiaRows) throw new Error("nvidia-smi reported no CUDA devices");
  const devices = nvidiaRows.split(/\r?\n/).map((line) => {
    const fields = line.split(",").map((value) => value.trim());
    if (fields.length !== 6)
      throw new Error(`malformed nvidia-smi row: ${line}`);
    const [index, name, uuid, driverVersion, computeCapability, memoryMiB] =
      fields;
    return {
      index: Number(index),
      name,
      uuid,
      driverVersion,
      computeCapability,
      memoryMiB: Number(memoryMiB),
      inventoryProfile: inferProfile(name, computeCapability),
    };
  });
  const nvcc = capture("nvcc", ["--version"]);
  const smi = capture("nvidia-smi");
  const toolkitVersion = parseVersion(
    nvcc,
    /release\s+([0-9]+\.[0-9]+)/i,
    "CUDA toolkit version",
  );
  const runtimeVersion = parseVersion(
    smi,
    /CUDA Version:\s*([0-9]+\.[0-9]+)/i,
    "CUDA driver runtime version",
  );
  const exactHead = !expectedHead || head === expectedHead;
  return {
    schemaVersion: 1,
    status: exactHead ? "pass" : "fail",
    exactHead,
    head,
    expectedHead: expectedHead || head,
    nativeSourceCommit,
    repository: process.env.GITHUB_REPOSITORY || null,
    workflowRun: {
      id: process.env.GITHUB_RUN_ID || null,
      attempt: process.env.GITHUB_RUN_ATTEMPT || null,
      event: process.env.GITHUB_EVENT_NAME || null,
    },
    cuda: { toolkitVersion, driverRuntimeVersion: runtimeVersion },
    devices,
  };
}

export function validateInventory(inventory, { root = process.cwd() } = {}) {
  const errors = [];
  if (inventory?.schemaVersion !== 1)
    errors.push("inventory schemaVersion must be 1");
  if (
    inventory?.authority?.candidateWorkflow !==
    ".github/workflows/cuda-continuity.yml"
  )
    errors.push(
      "candidate workflow must be .github/workflows/cuda-continuity.yml",
    );
  const retired = new Set(
    (inventory?.retiredContexts || []).map((entry) => entry.id),
  );
  for (const id of ["gpu-bench-nightly.detect", "gpu-bench-nightly.bench"])
    if (!retired.has(id)) errors.push(`retired context missing: ${id}`);
  const matrix = inventory?.supportedMatrix || [];
  const matrixIds = new Set(matrix.map((entry) => entry.id));
  for (const id of [
    "rtx-3090-sm86",
    "rtx-4090-sm89",
    "h200-sm90",
    "rtx-5090-sm120",
  ])
    if (!matrixIds.has(id))
      errors.push(`supported matrix entry missing: ${id}`);
  for (const entry of matrix) {
    if (!entry.gpuProfile || !fs.existsSync(path.join(root, entry.gpuProfile)))
      errors.push(`GPU profile missing for ${entry.id}: ${entry.gpuProfile}`);
    if (
      !entry.architecture ||
      !entry.minimumToolkit ||
      !entry.backend ||
      !entry.runtime
    )
      errors.push(`incomplete supported matrix entry: ${entry.id}`);
  }
  const workflowPath = path.join(
    root,
    inventory?.authority?.candidateWorkflow || "",
  );
  if (!fs.existsSync(workflowPath)) {
    errors.push(`candidate workflow missing: ${workflowPath}`);
  } else {
    const workflow = fs.readFileSync(workflowPath, "utf8");
    for (const contract of [
      "runs-on: [self-hosted, gpu-cuda-12.6]",
      "cancel-in-progress: false",
      "cuda_runner.sh",
      '--expected-head "$GITHUB_SHA"',
      'CUDA_BUILD_FORK: "0"',
      "ELIZA_MTP_BIN_DIR",
      "ELIZA_MTP_GRAPH_REPORT_DIR",
      'test -s "$GRAPH_DIR/${CUDA_TARGET}-graph-smoke.summary"',
      'cat "$graph_log" >> artifacts/cuda-continuity/native.log',
      'CUDA_SKIP_GRAPH_SMOKE: "0"',
      "if-no-files-found: error",
      "scripts/cuda-continuity.mjs validate",
    ]) {
      if (!workflow.includes(contract))
        errors.push(`workflow continuity contract missing: ${contract}`);
    }
  }
  const harnessPath = path.join(root, inventory?.authority?.harness || "");
  if (!fs.existsSync(harnessPath))
    errors.push(`CUDA harness missing: ${harnessPath}`);
  if (errors.length) throw new Error(errors.join("\n"));
  return true;
}

export function validateManifest(manifest, { expectedHead } = {}) {
  const inventory = readJson(INVENTORY_PATH);
  const errors = [];
  if (manifest?.schemaVersion !== 1)
    errors.push("manifest schemaVersion must be 1");
  if (manifest?.status !== "pass") errors.push("manifest status is not pass");
  if (!manifest?.exactHead || !COMMIT_RE.test(manifest?.head || ""))
    errors.push("exact-head proof missing or invalid");
  if (expectedHead && manifest?.head !== expectedHead)
    errors.push(
      `head ${manifest?.head} does not match expected ${expectedHead}`,
    );
  if (!manifest?.hardware?.devices?.length)
    errors.push("no GPU device inventory");
  if (!manifest?.hardware?.cuda?.toolkitVersion)
    errors.push("CUDA toolkit version missing");
  if (!manifest?.hardware?.cuda?.driverRuntimeVersion)
    errors.push("CUDA driver runtime version missing");
  if (
    manifest?.nativeVerification?.status !== "pass" ||
    manifest?.nativeVerification?.passRecordable !== true
  )
    errors.push("native CUDA verification is not a recordable pass");
  if (manifest?.nativeVerification?.graphSmoke !== "required")
    errors.push("runtime graph smoke was not completed");
  if (!SHA256_RE.test(manifest?.nativeVerification?.modelSha256 || ""))
    errors.push("model-backed graph smoke SHA-256 missing or invalid");
  if (
    !COMMIT_RE.test(manifest?.buildProvenance?.nativeSourceCommit || "") ||
    manifest?.buildProvenance?.forkCommit !==
      manifest?.buildProvenance?.nativeSourceCommit
  )
    errors.push(
      "CUDA binary fork commit does not match the exact-head native source gitlink",
    );
  if (!Number.isFinite(Date.parse(manifest?.buildProvenance?.builtAt || "")))
    errors.push("CUDA binary builtAt provenance missing or invalid");
  const coverage = new Set(manifest?.coverage || []);
  for (const id of inventory.requiredEvidence)
    if (!coverage.has(id)) errors.push(`required evidence missing: ${id}`);
  const artifacts = manifest?.artifacts || [];
  const artifactIds = new Set();
  for (const artifact of artifacts) {
    if (!artifact?.id || artifactIds.has(artifact.id))
      errors.push(`duplicate or missing artifact id: ${artifact?.id}`);
    artifactIds.add(artifact.id);
    if (
      !artifact?.path ||
      !SHA256_RE.test(artifact?.sha256 || "") ||
      !(artifact?.bytes > 0)
    )
      errors.push(`invalid artifact entry: ${artifact?.id || "unknown"}`);
  }
  for (const id of ["cuda-probe", "cuda-report", "capabilities", "native-log"])
    if (!artifactIds.has(id)) errors.push(`artifact shard missing: ${id}`);
  const missingKernels = manifest?.capabilities?.missingRequiredKernels || [];
  const kernelClaims = manifest?.capabilities?.kernels || {};
  const unprovenKernels = inventory.requiredKernels.filter(
    (kernel) => kernelClaims[kernel] !== true,
  );
  if (
    manifest?.capabilities?.publishable !== true ||
    missingKernels.length ||
    unprovenKernels.length
  )
    errors.push(
      `CUDA capabilities are not publishable; missing kernels: ${[
        ...new Set([...missingKernels, ...unprovenKernels]),
      ].join(", ")}`,
    );
  if ((manifest?.logPolicy?.forbiddenSignals || []).length)
    errors.push(
      `native log contains fail-closed signals: ${manifest.logPolicy.forbiddenSignals.join(", ")}`,
    );
  if (errors.length) throw new Error(errors.join("\n"));
  return true;
}

export function assembleManifest({
  probePath,
  reportPath,
  capabilitiesPath,
  logPath,
  outputPath,
  expectedHead,
}) {
  const inventory = readJson(INVENTORY_PATH);
  validateInventory(inventory);
  for (const file of [probePath, reportPath, capabilitiesPath, logPath])
    if (!file || !fs.existsSync(file) || fs.statSync(file).size === 0)
      throw new Error(`required artifact missing or empty: ${file}`);
  const probe = readJson(probePath);
  const report = readJson(reportPath);
  const capabilities = readJson(capabilitiesPath);
  const nativeLog = fs.readFileSync(logPath, "utf8");
  const forbiddenSignals = FORBIDDEN_LOG_SIGNALS.filter((pattern) =>
    pattern.test(nativeLog),
  ).map((pattern) => pattern.source);
  const artifacts = [
    ["cuda-probe", probePath],
    ["cuda-report", reportPath],
    ["capabilities", capabilitiesPath],
    ["native-log", logPath],
  ].map(([id, file]) => ({
    id,
    path: path.basename(file),
    bytes: fs.statSync(file).size,
    sha256: sha256(file),
  }));
  const manifest = {
    schemaVersion: 1,
    status: "pass",
    createdAt: new Date().toISOString(),
    head: probe.head,
    exactHead: probe.exactHead === true && probe.status === "pass",
    workflowRun: probe.workflowRun,
    authority: inventory.authority,
    hardware: { devices: probe.devices, cuda: probe.cuda },
    buildProvenance: {
      nativeSourceCommit: probe.nativeSourceCommit,
      forkCommit: capabilities.forkCommit,
      builtAt: capabilities.builtAt,
      target: capabilities.target || report.target,
    },
    nativeVerification: {
      status: report.status,
      passRecordable: report.passRecordable,
      graphSmoke: report.requirements?.graphSmoke,
      target: report.target,
      modelSha256: report.evidence?.modelSha256 || null,
    },
    capabilities: {
      publishable: capabilities.publishable,
      missingRequiredKernels: capabilities.missingRequiredKernels || [],
      kernels: capabilities.kernels || {},
    },
    coverage: inventory.requiredEvidence,
    retiredContextMapping: inventory.retiredContexts,
    supportedMatrixInventory: inventory.supportedMatrix,
    logPolicy: { forbiddenSignals },
    artifacts,
  };
  validateManifest(manifest, {
    expectedHead: expectedHead || probe.expectedHead,
  });
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

function argsToObject(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--") || !argv[i + 1])
      throw new Error(`invalid argument: ${key}`);
    out[key.slice(2)] = argv[++i];
  }
  return out;
}

function usage() {
  console.error(
    "Usage: cuda-continuity.mjs probe --output FILE | assemble --probe FILE --report FILE --capabilities FILE --log FILE --output FILE [--expected-head SHA] | validate --manifest FILE [--expected-head SHA] | validate-inventory",
  );
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = argsToObject(rest);
  if (command === "probe") {
    if (!args.output) throw new Error("--output is required");
    let probe;
    try {
      probe = collectProbe({ expectedHead: args["expected-head"] });
    } catch (error) {
      probe = {
        schemaVersion: 1,
        status: "fail",
        exactHead: false,
        failureReason: error instanceof Error ? error.message : String(error),
      };
    }
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, `${JSON.stringify(probe, null, 2)}\n`);
    if (probe.status !== "pass")
      throw new Error(probe.failureReason || "CUDA probe failed");
  } else if (command === "assemble") {
    assembleManifest({
      probePath: args.probe,
      reportPath: args.report,
      capabilitiesPath: args.capabilities,
      logPath: args.log,
      outputPath: args.output,
      expectedHead: args["expected-head"],
    });
  } else if (command === "validate") {
    validateManifest(readJson(args.manifest), {
      expectedHead: args["expected-head"],
    });
  } else if (command === "validate-inventory") {
    validateInventory(readJson(INVENTORY_PATH));
  } else {
    usage();
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(
      `[cuda-continuity] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
