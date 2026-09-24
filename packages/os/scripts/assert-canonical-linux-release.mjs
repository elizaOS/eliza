#!/usr/bin/env node
// Prevents the public release coordinator from promoting the retired ISO path
// as the accepted persistent mkosi v1 product.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, readJson } from "./os-release-lib.mjs";

export const canonicalArchitectures = ["x86_64", "arm64", "riscv64"];
export const canonicalEvidence = [
  "mkosi-release-build",
  "qemu-uefi-usb",
  "persistent-reboot",
  "usb-expanded-readback",
  "whole-disk-install",
  "alongside-install",
  "desktop-acceptance",
  "hardware-qualification",
];
export const canonicalSignatureEvidence = [
  "ed25519-signature",
  "image-release-verified",
];

export function validateCanonicalLinuxRelease(manifest) {
  const errors = [];
  const rawImages = (manifest?.artifacts ?? []).filter(
    (artifact) =>
      artifact?.kind === "raw-image" && artifact?.status !== "withdrawn",
  );
  const activeArtifacts = (manifest?.artifacts ?? []).filter(
    (artifact) => artifact?.status !== "withdrawn",
  );
  for (const architecture of canonicalArchitectures) {
    const matches = rawImages.filter(
      (artifact) => artifact?.target?.architecture === architecture,
    );
    if (matches.length !== 1) {
      errors.push(
        `canonical Linux release requires exactly one ${architecture} raw image; found ${matches.length}`,
      );
      continue;
    }
    const artifact = matches[0];
    if (!artifact.filename.endsWith(`-${architecture}.raw.zst`)) {
      errors.push(
        `${artifact.id} filename must end in -${architecture}.raw.zst`,
      );
    }
    if (artifact.source?.pattern !== "*.raw.zst") {
      errors.push(`${artifact.id} source pattern must be *.raw.zst`);
    }
    const requiredEvidence = new Set(
      artifact.validation?.requiredEvidence ?? [],
    );
    for (const evidence of canonicalEvidence) {
      if (!requiredEvidence.has(evidence)) {
        errors.push(`${artifact.id} must require ${evidence} evidence`);
      }
    }
    const signatures = activeArtifacts.filter(
      (candidate) =>
        candidate?.kind === "signature" &&
        candidate?.target?.platform === "linux" &&
        candidate?.target?.architecture === architecture &&
        candidate?.filename === `${artifact.filename}.sig`,
    );
    if (signatures.length !== 1) {
      errors.push(
        `${artifact.id} requires exactly one declared detached signature; found ${signatures.length}`,
      );
    } else {
      const signature = signatures[0];
      if (signature.source?.artifact !== artifact.source?.artifact) {
        errors.push(
          `${signature.id} must be produced beside ${artifact.id} by the same Actions artifact`,
        );
      }
      const signatureEvidence = new Set(
        signature.validation?.requiredEvidence ?? [],
      );
      for (const evidence of canonicalSignatureEvidence) {
        if (!signatureEvidence.has(evidence)) {
          errors.push(`${signature.id} must require ${evidence} evidence`);
        }
      }
    }
    const sboms = activeArtifacts.filter(
      (candidate) =>
        candidate?.kind === "sbom" &&
        candidate?.target?.platform === "linux" &&
        candidate?.target?.architecture === architecture,
    );
    if (sboms.length !== 1) {
      errors.push(
        `${artifact.id} requires exactly one architecture-matched SBOM; found ${sboms.length}`,
      );
    } else if (sboms[0].source?.artifact !== artifact.source?.artifact) {
      errors.push(
        `${sboms[0].id} must be produced beside ${artifact.id} by the same Actions artifact`,
      );
    }
  }
  for (const artifact of rawImages) {
    if (!canonicalArchitectures.includes(artifact?.target?.architecture)) {
      errors.push(
        `${artifact.id} has unsupported canonical architecture ${artifact?.target?.architecture}`,
      );
    }
    if (artifact.filename.endsWith(".iso")) {
      errors.push(`${artifact.id} is a retired ISO, not a canonical v1 image`);
    }
  }
  const metadata = activeArtifacts.filter(
    (artifact) =>
      artifact?.kind === "release-metadata" &&
      artifact?.target?.platform === "linux",
  );
  if (metadata.length !== 1) {
    errors.push(
      `canonical Linux release requires exactly one signed discovery manifest; found ${metadata.length}`,
    );
  } else {
    const discovery = metadata[0];
    const expectedFilename = `elizaos-${manifest?.release?.version}-images.json`;
    if (discovery.filename !== expectedFilename) {
      errors.push(`${discovery.id} filename must be ${expectedFilename}`);
    }
    const manifestSignature = activeArtifacts.filter(
      (artifact) =>
        artifact?.kind === "signature" &&
        artifact?.target?.platform === "linux" &&
        artifact?.target?.architecture === "all" &&
        artifact?.filename === `${discovery.filename}.sig`,
    );
    if (manifestSignature.length !== 1) {
      errors.push(
        `${discovery.id} requires exactly one declared manifest signature; found ${manifestSignature.length}`,
      );
    } else if (
      manifestSignature[0].source?.artifact !== discovery.source?.artifact
    ) {
      errors.push(
        `${manifestSignature[0].id} must be produced beside ${discovery.id} by the same Actions artifact`,
      );
    }
    for (const signedArtifact of [discovery, ...manifestSignature]) {
      const requiredEvidence = new Set(
        signedArtifact.validation?.requiredEvidence ?? [],
      );
      for (const evidence of canonicalSignatureEvidence) {
        if (!requiredEvidence.has(evidence)) {
          errors.push(`${signedArtifact.id} must require ${evidence} evidence`);
        }
      }
    }
  }
  return errors;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) throw new Error("missing required argument: --manifest");
  const errors = validateCanonicalLinuxRelease(
    await readJson(path.resolve(args.manifest)),
  );
  if (errors.length > 0) {
    throw new Error(
      `candidate is not a canonical Linux v1 release:\n${errors.join("\n")}`,
    );
  }
}
