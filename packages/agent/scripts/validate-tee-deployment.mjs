#!/usr/bin/env node
import { readFileSync } from "node:fs";

const input =
  process.argv[2] ?? "packages/agent/tee/dstack-agent-deployment.example.json";
const revocationsInput = process.argv[3];
const deployment = JSON.parse(readFileSync(input, "utf8"));
const revocations = revocationsInput
  ? JSON.parse(readFileSync(revocationsInput, "utf8"))
  : undefined;
const errors = validateDeployment(deployment, revocations);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`error: ${error}`);
  }
  process.exit(1);
}

console.log(
  `TEE deployment valid: ${input}${
    revocationsInput ? ` against ${revocationsInput}` : ""
  }`,
);

function validateDeployment(value, revocationManifest) {
  const errors = [];
  if (value?.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  requireString(errors, value?.deploymentId, "deploymentId");
  if (value?.provider !== "dstack") {
    errors.push("provider must be dstack");
  }
  if (!Array.isArray(value?.teeKinds) || value.teeKinds.length === 0) {
    errors.push("teeKinds must be a non-empty array");
  }
  requireString(errors, value?.image?.repository, "image.repository");
  requireString(errors, value?.image?.tag, "image.tag");
  requireDigest(errors, value?.image?.digest, "image.digest");
  requireDigest(errors, value?.composeDigest, "composeDigest");
  requireDigest(errors, value?.policyDigest, "policyDigest");
  requireString(errors, value?.kms?.url, "kms.url");
  if (value?.kms?.requiresFreshNonce !== true) {
    errors.push("kms.requiresFreshNonce must be true");
  }
  for (const claim of ["debugDisabled", "secureBoot"]) {
    if (value?.requiredClaims?.[claim] !== true) {
      errors.push(`requiredClaims.${claim} must be true`);
    }
  }
  for (const measurement of ["agent", "policy", "container"]) {
    requireDigest(
      errors,
      value?.requiredMeasurements?.[measurement],
      `requiredMeasurements.${measurement}`,
    );
  }
  if (!Array.isArray(value?.secretScopes) || value.secretScopes.length === 0) {
    errors.push("secretScopes must be a non-empty array");
  }
  if (value?.network?.raTlsRequired !== true) {
    errors.push("network.raTlsRequired must be true");
  }
  if (value?.requiredMeasurements?.agent !== value?.image?.digest) {
    errors.push("requiredMeasurements.agent must match image.digest");
  }
  if (value?.requiredMeasurements?.policy !== value?.policyDigest) {
    errors.push("requiredMeasurements.policy must match policyDigest");
  }
  if (value?.requiredMeasurements?.container !== value?.composeDigest) {
    errors.push("requiredMeasurements.container must match composeDigest");
  }
  validateDeploymentNotRevoked(errors, value, revocationManifest);
  return errors;
}

function validateDeploymentNotRevoked(errors, deployment, revocationManifest) {
  if (revocationManifest === undefined) return;
  if (revocationManifest?.schemaVersion !== 1) {
    errors.push("revocation manifest schemaVersion must be 1");
    return;
  }
  const revokedMeasurements = revocationManifest.revokedMeasurements ?? {};
  for (const [name, digest] of Object.entries(
    deployment.requiredMeasurements ?? {},
  )) {
    const revokedDigests = (revokedMeasurements[name] ?? [])
      .map((entry) => (typeof entry === "string" ? entry : entry?.value))
      .filter((entry) => typeof entry === "string");
    if (revokedDigests.includes(digest)) {
      errors.push(`requiredMeasurements.${name} is revoked`);
    }
  }
}

function requireString(errors, value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${field} must be a non-empty string`);
  }
}

function requireDigest(errors, value, field) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    errors.push(`${field} must be sha256:<64 lowercase hex>`);
  }
}
