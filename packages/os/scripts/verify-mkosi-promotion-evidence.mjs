#!/usr/bin/env node
// Binds the canonical compressed/expanded image pair and SPDX document to the
// bounded mkosi assembly, QEMU USB-boot, virtual readback, and two-boot
// persistence records. This intentionally does not claim installer,
// desktop-acceptance, or physical-hardware proof.
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, sha256File } from "./os-release-lib.mjs";

const architectures = new Set(["x86_64", "arm64", "riscv64"]);
const buildArchitecture = { x86_64: "amd64", arm64: "arm64", riscv64: "riscv64" };

async function regularFile(value, label) {
  const resolved = path.resolve(value);
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size === 0) {
    throw new Error(`${label} must be a nonempty regular file, not a symlink`);
  }
  return { path: resolved, size: stats.size, sha256: await sha256File(resolved) };
}

async function jsonFile(value, label) {
  const record = await regularFile(value, label);
  try {
    return { ...record, document: JSON.parse(await readFile(record.path, "utf8")) };
  } catch (error) {
    throw new Error(`${label} must contain valid JSON: ${error.message}`);
  }
}

const args = parseArgs(process.argv.slice(2));
const required = [
  "architecture",
  "compressed",
  "expanded",
  "build-evidence",
  "qemu-evidence",
  "persistence-evidence",
  "sbom",
  "source-sha",
];
const missing = required.filter((name) => !args[name]);
if (args.architecture === "x86_64" && !args["legacy-bios-evidence"]) {
  missing.push("legacy-bios-evidence");
}
if (missing.length > 0) {
  throw new Error(`missing required arguments: ${missing.map((name) => `--${name}`).join(", ")}`);
}
if (!architectures.has(args.architecture)) {
  throw new Error("--architecture must be x86_64, arm64, or riscv64");
}
if (args.architecture !== "x86_64" && args["legacy-bios-evidence"]) {
  throw new Error("--legacy-bios-evidence is valid only for x86_64");
}
if (!/^[a-f0-9]{40}$/.test(args["source-sha"])) {
  throw new Error("--source-sha must be a lowercase 40-character Git commit");
}

const [compressed, expanded, build, qemu, persistence, sbom] = await Promise.all([
  regularFile(args.compressed, "compressed image"),
  regularFile(args.expanded, "expanded image"),
  jsonFile(args["build-evidence"], "mkosi build evidence"),
  jsonFile(args["qemu-evidence"], "QEMU evidence"),
  jsonFile(args["persistence-evidence"], "persistence evidence"),
  jsonFile(args.sbom, "SPDX SBOM"),
]);
const legacyBios = args["legacy-bios-evidence"]
  ? await jsonFile(args["legacy-bios-evidence"], "legacy BIOS QEMU evidence")
  : null;

const errors = [];
if (expanded.size <= compressed.size) {
  errors.push("expanded image must be larger than compressed image");
}
const buildDocument = build.document;
if (buildDocument.schema !== "ai.elizaos.mkosi-build-evidence.v1") {
  errors.push("mkosi build evidence schema mismatch");
}
if (
  buildDocument.claimBoundary !==
  "mkosi_disk_assembly_only_no_boot_or_hardware_claim"
) {
  errors.push("mkosi build evidence claim boundary mismatch");
}
if (
  buildDocument.success !== true ||
  buildDocument.preflightOnly !== false ||
  buildDocument.buildMode !== "release" ||
  buildDocument.sourceDirty !== false
) {
  errors.push("mkosi build evidence is not a successful clean release assembly");
}
if (buildDocument.architecture !== buildArchitecture[args.architecture]) {
  errors.push("mkosi build evidence architecture mismatch");
}
if (buildDocument.sourceCommit !== args["source-sha"]) {
  errors.push("mkosi build evidence source commit mismatch");
}
const buildSubjects = Array.isArray(buildDocument.artifacts)
  ? buildDocument.artifacts
  : [];
if (
  buildSubjects.filter(
    (artifact) =>
      artifact?.sha256 === compressed.sha256 &&
      artifact?.size === compressed.size &&
      String(artifact?.path ?? "").endsWith(".raw.zst"),
  ).length !== 1
) {
  errors.push("mkosi build evidence does not bind the exact compressed image");
}

const qemuDocument = qemu.document;
if (qemuDocument.schema !== "ai.elizaos.mkosi-qemu-evidence.v1") {
  errors.push("QEMU evidence schema mismatch");
}
if (
  qemuDocument.claimBoundary !==
  "qemu_graphical_target_only_no_login_agent_computer_control_or_hardware_claim"
) {
  errors.push("QEMU evidence claim boundary mismatch");
}
if (
  qemuDocument.success !== true ||
  qemuDocument.preflightOnly !== false ||
  qemuDocument.diskInterface !== "usb" ||
  qemuDocument.firmwareMode !== (args.architecture === "riscv64" ? "bios" : "pflash") ||
  qemuDocument.terminationReason !== "required-markers"
) {
  errors.push("QEMU evidence is not a successful removable-USB qualification");
}
if (
  typeof qemuDocument.emulator?.path !== "string" ||
  !qemuDocument.emulator.path.startsWith("/") ||
  typeof qemuDocument.emulator?.version !== "string" ||
  qemuDocument.emulator.version.length === 0
) {
  errors.push("QEMU evidence does not record the exact emulator path and version");
}
if (qemuDocument.architecture !== buildArchitecture[args.architecture]) {
  errors.push("QEMU evidence architecture mismatch");
}
if (
  qemuDocument.inputs?.image?.sha256 !== expanded.sha256 ||
  qemuDocument.inputs?.image?.size !== expanded.size
) {
  errors.push("QEMU evidence does not bind the exact expanded image");
}
for (const marker of ["Linux version", "Reached target Graphical Interface"]) {
  if (!qemuDocument.markersFound?.includes(marker)) {
    errors.push(`QEMU evidence is missing required marker: ${marker}`);
  }
}
if ((qemuDocument.forbiddenMarkersFound ?? []).length !== 0) {
  errors.push("QEMU evidence contains a forbidden boot marker");
}
if (qemuDocument.firmwareMode === "pflash") {
  if (
    !/^[a-f0-9]{64}$/.test(qemuDocument.inputs?.firmwareCode?.sha256 ?? "") ||
    !/^[a-f0-9]{64}$/.test(
      qemuDocument.inputs?.firmwareVarsTemplate?.sha256 ?? "",
    ) ||
    qemuDocument.inputs?.bios
  ) {
    errors.push("QEMU evidence does not bind one explicit pflash firmware pair");
  }
} else if (
  !/^[a-f0-9]{64}$/.test(qemuDocument.inputs?.bios?.sha256 ?? "") ||
  qemuDocument.inputs?.firmwareCode ||
  qemuDocument.inputs?.firmwareVarsTemplate
) {
  errors.push("QEMU evidence does not bind one explicit combined firmware image");
}

if (args.architecture === "x86_64") {
  const legacyDocument = legacyBios?.document;
  if (legacyDocument?.schema !== "ai.elizaos.mkosi-qemu-evidence.v1") {
    errors.push("legacy BIOS QEMU evidence schema mismatch");
  }
  if (
    legacyDocument?.claimBoundary !==
    "qemu_graphical_target_only_no_login_agent_computer_control_or_hardware_claim"
  ) {
    errors.push("legacy BIOS QEMU evidence claim boundary mismatch");
  }
  if (
    legacyDocument?.success !== true ||
    legacyDocument?.preflightOnly !== false ||
    legacyDocument?.architecture !== "amd64" ||
    legacyDocument?.diskInterface !== "usb" ||
    legacyDocument?.firmwareMode !== "bios" ||
    legacyDocument?.terminationReason !== "required-markers"
  ) {
    errors.push("legacy BIOS evidence is not a successful removable-USB qualification");
  }
  if (
    typeof legacyDocument?.emulator?.path !== "string" ||
    !legacyDocument.emulator.path.startsWith("/") ||
    typeof legacyDocument?.emulator?.version !== "string" ||
    legacyDocument.emulator.version.length === 0
  ) {
    errors.push("legacy BIOS evidence does not record the emulator path and version");
  }
  if (
    legacyDocument?.inputs?.image?.sha256 !== expanded.sha256 ||
    legacyDocument?.inputs?.image?.size !== expanded.size
  ) {
    errors.push("legacy BIOS evidence does not bind the exact expanded image");
  }
  if (
    !/^[a-f0-9]{64}$/.test(legacyDocument?.inputs?.bios?.sha256 ?? "") ||
    legacyDocument?.inputs?.firmwareCode ||
    legacyDocument?.inputs?.firmwareVarsTemplate
  ) {
    errors.push("legacy BIOS evidence does not bind one explicit BIOS firmware image");
  }
  for (const marker of ["Linux version", "Reached target Graphical Interface"]) {
    if (!legacyDocument?.markersFound?.includes(marker)) {
      errors.push(`legacy BIOS evidence is missing required marker: ${marker}`);
    }
  }
  if ((legacyDocument?.forbiddenMarkersFound ?? []).length !== 0) {
    errors.push("legacy BIOS evidence contains a forbidden boot marker");
  }
}

const persistenceDocument = persistence.document;
if (persistenceDocument.schema !== "ai.elizaos.mkosi-persistence-evidence.v1") {
  errors.push("persistence evidence schema mismatch");
}
if (
  persistenceDocument.claimBoundary !==
  "virtual_usb_write_readback_and_two_boot_home_persistence_no_installer_desktop_or_physical_hardware_claim"
) {
  errors.push("persistence evidence claim boundary mismatch");
}
if (
  persistenceDocument.success !== true ||
  persistenceDocument.preflightOnly !== false ||
  persistenceDocument.architecture !== buildArchitecture[args.architecture]
) {
  errors.push("persistence evidence is not a successful architecture-bound qualification");
}
if (
  persistenceDocument.sourceImage?.sha256 !== expanded.sha256 ||
  persistenceDocument.sourceImage?.size !== expanded.size
) {
  errors.push("persistence evidence does not bind the exact expanded image");
}
if (
  persistenceDocument.virtualUsbReadback?.sha256 !== expanded.sha256 ||
  persistenceDocument.virtualUsbReadback?.bytes !== expanded.size ||
  persistenceDocument.virtualUsbReadback?.interface !==
    "loop-block-written-then-qemu-removable-usb"
) {
  errors.push("virtual USB readback does not bind every expanded image byte");
}
const home = persistenceDocument.home;
if (
  !Number.isSafeInteger(home?.partitionBytesBefore) ||
  !Number.isSafeInteger(home?.partitionBytesAfter) ||
  !Number.isSafeInteger(home?.filesystemBytesBefore) ||
  !Number.isSafeInteger(home?.filesystemBytesAfter) ||
  home.partitionBytesAfter <= home.partitionBytesBefore ||
  home.filesystemBytesAfter <= home.filesystemBytesBefore ||
  home.survivedSecondBoot !== true ||
  !/^[a-f0-9]{64}$/.test(home?.sentinelSha256 ?? "")
) {
  errors.push("two-boot home growth or sentinel evidence is invalid");
}
if (!Array.isArray(persistenceDocument.boots) || persistenceDocument.boots.length !== 2) {
  errors.push("persistence evidence must contain exactly two successful boots");
} else {
  for (const [index, boot] of persistenceDocument.boots.entries()) {
    if (
      boot?.terminationReason !== "required-markers" ||
      !["Linux version", "Reached target Graphical Interface"].every((marker) =>
        boot?.markersFound?.includes(marker),
      ) ||
      (boot?.forbiddenMarkersFound ?? []).length !== 0 ||
      !Number.isSafeInteger(boot?.transcript?.size) ||
      boot.transcript.size <= 0 ||
      !/^[a-f0-9]{64}$/.test(boot?.transcript?.sha256 ?? "")
    ) {
      errors.push(`persistence boot ${index + 1} evidence is invalid`);
    }
  }
}

if (sbom.document.spdxVersion !== "SPDX-2.3") {
  errors.push("SBOM is not SPDX 2.3 JSON");
}
if (!Array.isArray(sbom.document.packages) || sbom.document.packages.length === 0) {
  errors.push("SBOM contains no installed packages");
}

if (errors.length > 0) {
  throw new Error(`mkosi promotion evidence is invalid:\n${errors.join("\n")}`);
}
process.stdout.write(
  `${JSON.stringify({ architecture: args.architecture, compressedSha256: compressed.sha256, expandedSha256: expanded.sha256, legacyBiosEvidenceSha256: legacyBios?.sha256, persistenceEvidenceSha256: persistence.sha256, sbomSha256: sbom.sha256 })}\n`,
);
