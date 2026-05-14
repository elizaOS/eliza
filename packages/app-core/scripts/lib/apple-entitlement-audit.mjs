import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appCoreRoot = path.resolve(__dirname, "..", "..");
const manifestPath = path.join(
  appCoreRoot,
  "platforms",
  "apple-store-entitlements.reviewed.json",
);

const REVIEW_SENSITIVE_ENTITLEMENTS = new Set([
  "com.apple.security.automation.apple-events",
  "com.apple.security.network.server",
  "com.apple.security.files.downloads.read-write",
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.cs.disable-library-validation",
  "com.apple.developer.family-controls",
  "com.apple.developer.healthkit",
  "com.apple.developer.healthkit.background-delivery",
  "com.apple.developer.kernel.increased-memory-limit",
  "com.apple.developer.kernel.extended-virtual-addressing",
]);

function decodeXmlText(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function extractFirstDictBody(plistXml, label) {
  const withoutComments = plistXml.replace(/<!--[\s\S]*?-->/g, "");
  const match = withoutComments.match(/<dict\b[^>]*>([\s\S]*?)<\/dict>/i);
  if (!match) {
    throw new Error(`${label}: missing top-level <dict> in entitlements plist`);
  }
  return match[1];
}

export function parseEntitlementsPlist(plistXml, label = "entitlements") {
  const body = extractFirstDictBody(plistXml, label);
  const entitlements = {};
  const keyPattern = /<key>([\s\S]*?)<\/key>/g;
  let keyMatch;
  while ((keyMatch = keyPattern.exec(body))) {
    const key = decodeXmlText(keyMatch[1].trim());
    const valueStart = keyPattern.lastIndex;
    const rest = body.slice(valueStart);
    const leadingWhitespace = rest.match(/^\s*/)?.[0].length ?? 0;
    const value = rest.slice(leadingWhitespace);
    if (value.startsWith("<true/>") || value.startsWith("<true />")) {
      entitlements[key] = true;
      continue;
    }
    if (value.startsWith("<false/>") || value.startsWith("<false />")) {
      entitlements[key] = false;
      continue;
    }
    const stringMatch = value.match(/^<string>([\s\S]*?)<\/string>/);
    if (stringMatch) {
      entitlements[key] = decodeXmlText(stringMatch[1]);
      continue;
    }
    const arrayMatch = value.match(/^<array\b[^>]*>([\s\S]*?)<\/array>/);
    if (arrayMatch) {
      entitlements[key] = [...arrayMatch[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map(
        (match) => decodeXmlText(match[1]),
      );
      continue;
    }
    throw new Error(`${label}: unsupported plist value for entitlement ${key}`);
  }
  return entitlements;
}

export function loadEntitlementReviewManifest() {
  if (!existsSync(manifestPath)) {
    throw new Error(`missing entitlement review manifest: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (!Array.isArray(manifest.targets)) {
    throw new Error(`${manifestPath}: targets must be an array`);
  }
  return manifest;
}

function findTarget(manifest, targetId) {
  const target = manifest.targets.find((entry) => entry.id === targetId);
  if (!target) {
    throw new Error(`${manifestPath}: missing target ${targetId}`);
  }
  return target;
}

function valuesEqual(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function valueMatchesPolicy(actual, policy) {
  if (Object.hasOwn(policy, "value")) {
    return valuesEqual(actual, policy.value);
  }
  if (typeof policy.stringPattern === "string") {
    return (
      typeof actual === "string" && new RegExp(policy.stringPattern).test(actual)
    );
  }
  if (Array.isArray(policy.arrayStringPatterns)) {
    return (
      Array.isArray(actual) &&
      actual.length === policy.arrayStringPatterns.length &&
      actual.every((value, index) => {
        const pattern = policy.arrayStringPatterns[index];
        return typeof value === "string" && new RegExp(pattern).test(value);
      })
    );
  }
  return false;
}

function describePolicy(policy) {
  if (Object.hasOwn(policy, "value")) {
    return JSON.stringify(policy.value);
  }
  if (policy.stringPattern) {
    return `string matching /${policy.stringPattern}/`;
  }
  if (policy.arrayStringPatterns) {
    return `array matching ${JSON.stringify(policy.arrayStringPatterns)}`;
  }
  return "<unrecognized policy>";
}

function validateTargetPolicy(target) {
  const errors = [];
  if (!target.allowedEntitlements || typeof target.allowedEntitlements !== "object") {
    errors.push(`${target.id}: allowedEntitlements must be an object`);
    return errors;
  }

  for (const [key, policy] of Object.entries(target.allowedEntitlements)) {
    const reviewedJustification =
      typeof policy.justification === "string"
        ? policy.justification
        : policy.appReviewJustification;
    if (
      typeof reviewedJustification !== "string" ||
      reviewedJustification.trim().length < 12
    ) {
      errors.push(`${target.id}: ${key} needs a reviewed justification`);
    }
    if (REVIEW_SENSITIVE_ENTITLEMENTS.has(key)) {
      if (policy.reviewSensitive !== true) {
        errors.push(`${target.id}: ${key} must be marked reviewSensitive`);
      }
      if (
        typeof policy.appReviewJustification !== "string" ||
        policy.appReviewJustification.trim().length < 24
      ) {
        errors.push(`${target.id}: ${key} needs appReviewJustification`);
      }
    }
  }
  return errors;
}

export function validateEntitlementsAgainstTarget({
  entitlements,
  targetId,
  manifest = loadEntitlementReviewManifest(),
  label = targetId,
}) {
  const target = findTarget(manifest, targetId);
  const allowed = target.allowedEntitlements;
  const errors = validateTargetPolicy(target);
  const actualKeys = Object.keys(entitlements).sort();
  const allowedKeys = Object.keys(allowed).sort();

  for (const key of actualKeys) {
    if (!Object.hasOwn(allowed, key)) {
      const sensitive = REVIEW_SENSITIVE_ENTITLEMENTS.has(key)
        ? " (review-sensitive)"
        : "";
      errors.push(`${label}: unexpected entitlement ${key}${sensitive}`);
    }
  }

  for (const key of allowedKeys) {
    if (!Object.hasOwn(entitlements, key)) {
      errors.push(`${label}: missing reviewed entitlement ${key}`);
      continue;
    }
    const policy = allowed[key];
    if (!valueMatchesPolicy(entitlements[key], policy)) {
      errors.push(
        `${label}: ${key} is ${JSON.stringify(
          entitlements[key],
        )}, expected ${describePolicy(policy)}`,
      );
    }
  }

  return errors;
}

export function assertReviewedEntitlementsText({
  plistXml,
  targetId,
  manifest,
  label = targetId,
}) {
  const entitlements = parseEntitlementsPlist(plistXml, label);
  const errors = validateEntitlementsAgainstTarget({
    entitlements,
    targetId,
    manifest,
    label,
  });
  if (errors.length > 0) {
    throw new Error(
      [
        `apple entitlement audit failed for ${label}`,
        ...errors.map((error) => `  - ${error}`),
      ].join("\n"),
    );
  }
  return entitlements;
}

export function assertReviewedEntitlementsFile({
  filePath,
  targetId,
  manifest,
  label = filePath,
}) {
  if (!existsSync(filePath)) {
    throw new Error(`missing entitlements file: ${filePath}`);
  }
  return assertReviewedEntitlementsText({
    plistXml: readFileSync(filePath, "utf8"),
    targetId,
    manifest,
    label,
  });
}

export function assertReviewedAppleStoreEntitlements() {
  const manifest = loadEntitlementReviewManifest();
  const errors = [];
  for (const target of manifest.targets) {
    try {
      assertReviewedEntitlementsFile({
        filePath: path.join(appCoreRoot, target.source),
        targetId: target.id,
        manifest,
        label: target.source,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}
