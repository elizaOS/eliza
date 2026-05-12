#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];
const BUNDLE_DEPENDENCY_FIELDS = ["bundleDependencies", "bundledDependencies"];
const LOCAL_PROTOCOLS = ["workspace:", "file:", "link:", "portal:"];

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringMap(value) {
  return (
    isPlainObject(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function hasLocalProtocol(value) {
  if (typeof value === "string") {
    return LOCAL_PROTOCOLS.some((protocol) => value.startsWith(protocol));
  }
  if (!isPlainObject(value)) {
    return false;
  }
  return Object.values(value).some((entry) => hasLocalProtocol(entry));
}

function collectDirectDependencySpecs(packageJson) {
  const specs = new Map();
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (!isStringMap(dependencies)) {
      continue;
    }
    for (const [name, specifier] of Object.entries(dependencies)) {
      if (!specs.has(name)) {
        specs.set(name, specifier);
      }
    }
  }
  return specs;
}

function removalReason(name, overrideValue, directDependencySpecs) {
  if (hasLocalProtocol(overrideValue)) {
    return "local override specifier";
  }

  const directSpec = directDependencySpecs.get(name);
  if (directSpec === undefined) {
    return null;
  }

  if (typeof overrideValue !== "string" || overrideValue !== directSpec) {
    return "conflicts with direct dependency";
  }

  return null;
}

export function sanitizeNpmPackageMetadata(
  repoRoot = process.cwd(),
  options = {},
) {
  const packageJsonPath = path.join(repoRoot, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const overrides = isPlainObject(packageJson.overrides)
    ? packageJson.overrides
    : null;
  const removed = [];
  const removedBundledDependencies = [];
  let changed = false;

  if (overrides) {
    const directDependencySpecs = collectDirectDependencySpecs(packageJson);
    const sanitizedOverrides = {};

    for (const [name, overrideValue] of Object.entries(overrides)) {
      const reason = removalReason(name, overrideValue, directDependencySpecs);
      if (reason) {
        removed.push({ name, reason });
        continue;
      }
      sanitizedOverrides[name] = overrideValue;
    }

    if (removed.length > 0) {
      if (Object.keys(sanitizedOverrides).length === 0) {
        delete packageJson.overrides;
      } else {
        packageJson.overrides = sanitizedOverrides;
      }
      changed = true;
    }
  }

  for (const field of BUNDLE_DEPENDENCY_FIELDS) {
    const bundledDependencies = packageJson[field];
    if (
      !Array.isArray(bundledDependencies) ||
      bundledDependencies.length === 0
    ) {
      continue;
    }
    removedBundledDependencies.push(...bundledDependencies);
    delete packageJson[field];
    changed = true;
  }

  if (!changed) {
    options.log?.(
      "[sanitize-npm-package-metadata] no npm package metadata changes needed",
    );
    return { changed: false, removed, removedBundledDependencies };
  }

  if (!options.dryRun) {
    fs.writeFileSync(
      packageJsonPath,
      `${JSON.stringify(packageJson, null, 2)}\n`,
      "utf8",
    );
  }

  if (removed.length > 0) {
    options.log?.(
      `[sanitize-npm-package-metadata] removed ${removed.length} npm-unsafe override(s): ${removed
        .map(({ name, reason }) => `${name} (${reason})`)
        .join(", ")}`,
    );
  }

  if (removedBundledDependencies.length > 0) {
    options.log?.(
      `[sanitize-npm-package-metadata] removed ${removedBundledDependencies.length} bundled dependencies from package metadata: ${removedBundledDependencies.join(", ")}`,
    );
  }

  return { changed: true, removed, removedBundledDependencies };
}

export function isDirectRun(
  metaUrl = import.meta.url,
  argv1 = process.argv[1],
) {
  return (
    typeof argv1 === "string" && path.resolve(argv1) === fileURLToPath(metaUrl)
  );
}

if (isDirectRun()) {
  sanitizeNpmPackageMetadata(process.cwd(), {
    dryRun: process.argv.includes("--dry-run"),
    log: console.log,
  });
}
