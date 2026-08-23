/**
 * Validates that Snap's pinned toolchain and filtered runtime closure match the
 * repository. This catches removed workspaces before Snapcraft reaches its
 * expensive architecture-specific build jobs.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const snapcraftPath = join(scriptDirectory, "snap/snapcraft.yaml");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expandWorkspacePattern(pattern) {
  if (!pattern.includes("*")) {
    return [join(repositoryRoot, pattern)];
  }

  const wildcardIndex = pattern.indexOf("*");
  const parent = join(repositoryRoot, pattern.slice(0, wildcardIndex));
  const suffix = pattern.slice(wildcardIndex + 1);
  if (!existsSync(parent)) {
    return [];
  }

  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name, suffix));
}

function collectWorkspaceNames(rootPackage) {
  const names = new Set();
  for (const pattern of rootPackage.workspaces ?? []) {
    for (const workspacePath of expandWorkspacePattern(pattern)) {
      const packagePath = join(workspacePath, "package.json");
      if (!existsSync(packagePath)) {
        continue;
      }
      const workspace = readJson(packagePath);
      if (typeof workspace.name === "string") {
        names.add(workspace.name);
      }
    }
  }
  return names;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} must be ${expected}, found ${actual}`);
  }
}

const rootPackage = readJson(join(repositoryRoot, "package.json"));
const snapcraft = readFileSync(snapcraftPath, "utf8");
const workspaceNames = collectWorkspaceNames(rootPackage);
const filters = [...snapcraft.matchAll(/--filter=([^\s\\]+)/g)].map(
  (match) => match[1],
);
const missingFilters = filters.filter((name) => !workspaceNames.has(name));

if (missingFilters.length > 0) {
  throw new Error(
    `Snap build filters reference missing workspaces: ${missingFilters.join(", ")}`,
  );
}

const keepBlock = snapcraft.match(/const keep = new Set\(\[([\s\S]*?)\]\);/);
if (!keepBlock) {
  throw new Error("Snap plugin keep set was not found");
}

const keptPluginDirectories = [...keepBlock[1].matchAll(/"([^"]+)"/g)].map(
  (match) => match[1],
);
const missingPluginDirectories = keptPluginDirectories.filter(
  (directory) =>
    !existsSync(join(repositoryRoot, "plugins", directory, "package.json")),
);

if (missingPluginDirectories.length > 0) {
  throw new Error(
    `Snap plugin keep set references missing directories: ${missingPluginDirectories.join(", ")}`,
  );
}

const nodeVersion = rootPackage.engines?.node;
const bunVersion = rootPackage.packageManager?.replace(/^bun@/, "");
const snapNodeVersion = snapcraft.match(/NODE_VERSION="([^"]+)"/)?.[1];
const snapBunVersion = snapcraft.match(/BUN_VERSION="([^"]+)"/)?.[1];

assertEqual(snapNodeVersion, nodeVersion, "Snap Node version");
assertEqual(snapBunVersion, bunVersion, "Snap Bun version");
