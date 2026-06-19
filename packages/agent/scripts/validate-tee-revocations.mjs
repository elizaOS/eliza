#!/usr/bin/env node
import { readFileSync } from "node:fs";

const input = process.argv[2] ?? "packages/agent/tee/revocations.example.json";
const manifest = JSON.parse(readFileSync(input, "utf8"));
const errors = validateRevocations(manifest);

if (errors.length > 0) {
  for (const error of errors) {
    console.error(`error: ${error}`);
  }
  process.exit(1);
}

console.log(`TEE revocations valid: ${input}`);

function validateRevocations(value) {
  const errors = [];
  if (value?.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  requireOptionalString(errors, value?.authority, "authority");
  requireOptionalTimestamp(errors, value?.generatedAt, "generatedAt");

  const revokedMeasurements = value?.revokedMeasurements;
  if (
    revokedMeasurements !== undefined &&
    (!revokedMeasurements ||
      typeof revokedMeasurements !== "object" ||
      Array.isArray(revokedMeasurements))
  ) {
    errors.push("revokedMeasurements must be an object when present");
  }

  for (const [name, entries] of Object.entries(revokedMeasurements ?? {})) {
    if (!["boot", "os", "agent", "policy", "container"].includes(name)) {
      errors.push(`revokedMeasurements.${name} is not a known measurement`);
    }
    if (!Array.isArray(entries) || entries.length === 0) {
      errors.push(`revokedMeasurements.${name} must be a non-empty array`);
      continue;
    }
    entries.forEach((entry, index) =>
      validateDigestEntry(
        errors,
        entry,
        `revokedMeasurements.${name}[${index}]`,
      ),
    );
  }

  const revokedSecurityVersions = value?.revokedSecurityVersions;
  if (
    revokedSecurityVersions !== undefined &&
    !Array.isArray(revokedSecurityVersions)
  ) {
    errors.push("revokedSecurityVersions must be an array when present");
  }
  for (const [index, entry] of (revokedSecurityVersions ?? []).entries()) {
    validateSecurityVersionEntry(
      errors,
      entry,
      `revokedSecurityVersions[${index}]`,
    );
  }

  return errors;
}

function validateDigestEntry(errors, entry, field) {
  if (typeof entry === "string") {
    requireDigest(errors, entry, field);
    return;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${field} must be a digest string or object`);
    return;
  }
  requireDigest(errors, entry.value, `${field}.value`);
  requireOptionalString(errors, entry.reason, `${field}.reason`);
  requireOptionalString(errors, entry.source, `${field}.source`);
  requireOptionalTimestamp(errors, entry.revokedAt, `${field}.revokedAt`);
}

function validateSecurityVersionEntry(errors, entry, field) {
  if (typeof entry === "number") {
    requireSecurityVersion(errors, entry, field);
    return;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    errors.push(`${field} must be a version number or object`);
    return;
  }
  requireSecurityVersion(errors, entry.value, `${field}.value`);
  requireOptionalString(errors, entry.reason, `${field}.reason`);
  requireOptionalString(errors, entry.source, `${field}.source`);
  requireOptionalTimestamp(errors, entry.revokedAt, `${field}.revokedAt`);
}

function requireDigest(errors, value, field) {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    errors.push(`${field} must be sha256:<64 lowercase hex>`);
  }
}

function requireSecurityVersion(errors, value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    errors.push(`${field} must be a non-negative safe integer`);
  }
}

function requireOptionalString(errors, value, field) {
  if (value !== undefined && (typeof value !== "string" || !value.trim())) {
    errors.push(`${field} must be a non-empty string when present`);
  }
}

function requireOptionalTimestamp(errors, value, field) {
  if (value === undefined) return;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${field} must be an ISO-parseable timestamp when present`);
  }
}
