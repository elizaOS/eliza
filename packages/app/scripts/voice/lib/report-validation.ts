import fs from "node:fs";
import path from "node:path";

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function getNumber(source, keys) {
  if (!isObject(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

export function getString(source, keys) {
  if (!isObject(source)) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function pushNumberError(errors, label, value, predicate, hint) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !predicate(value)
  ) {
    errors.push(`${label} must be ${hint}`);
  }
}

function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

function artifactPathExists(artifactPath, reportPath, repoRoot) {
  if (isUrl(artifactPath)) return true;
  const candidates = [];
  if (path.isAbsolute(artifactPath)) candidates.push(artifactPath);
  else {
    if (reportPath)
      candidates.push(path.resolve(path.dirname(reportPath), artifactPath));
    if (repoRoot) candidates.push(path.resolve(repoRoot, artifactPath));
    candidates.push(path.resolve(process.cwd(), artifactPath));
  }
  return candidates.some((candidate) => fs.existsSync(candidate));
}

export function validateIsoTimestamp(errors, label, value) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    errors.push(`${label} must be an ISO timestamp`);
  }
}

export function validateArtifact(errors, artifact, context) {
  if (!isObject(artifact)) {
    errors.push(
      `${context.label}.artifacts[${context.index}] must be an object`,
    );
    return;
  }
  const artifactKind = getString(artifact, ["kind", "type"]);
  const artifactPath = getString(artifact, ["path", "href", "url"]);
  if (!artifactKind) {
    errors.push(
      `${context.label}.artifacts[${context.index}].kind is required`,
    );
  }
  if (!artifactPath) {
    errors.push(
      `${context.label}.artifacts[${context.index}].path is required`,
    );
  } else if (
    !artifactPathExists(artifactPath, context.reportPath, context.repoRoot)
  ) {
    errors.push(
      `${context.label}.artifacts[${context.index}].path does not exist: ${artifactPath}`,
    );
  }
  if (artifact.reviewed !== true) {
    errors.push(
      `${context.label}.artifacts[${context.index}].reviewed must be true after manual review`,
    );
  }
}
