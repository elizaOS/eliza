#!/usr/bin/env node
/**
 * Resolves the agent image's runtime workspaces and registry dependencies from
 * manifests. The image linker uses the same closure; development and optional
 * dependencies do not expand it, and the linked UI stays a static asset surface.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectWorkspaceMaps } from "../../scripts/lib/workspaces.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> app-core -> packages -> repo root
const repoRoot = path.resolve(__dirname, "..", "..", "..");

// Supported image entrypoints; transitive runtime workspaces come from manifests.
const LINKED_WORKSPACE_PACKAGES = [
  "packages/agent",
  "packages/app-core",
  "plugins/plugin-documents",
  "plugins/plugin-personal-assistant",
  "plugins/plugin-pdf",
  "plugins/plugin-telegram",
  "plugins/plugin-x",
  "plugins/plugin-native-activity-tracker",
];

/** Resolve declared runtime dependencies without adding development or optional peers. */
export function collectDockerWorkspaceDirs(
  root = repoRoot,
  roots = LINKED_WORKSPACE_PACKAGES,
) {
  const manifest = readJson(path.join(root, "package.json"));
  const { nameToDir } = collectWorkspaceMaps(root, manifest.workspaces);
  const pending = roots.map((entry) => path.resolve(root, entry));
  const visited = new Set();
  for (let index = 0; index < pending.length; index += 1) {
    const directory = pending[index];
    if (visited.has(directory)) continue;
    visited.add(directory);
    const pkg = readJson(path.join(directory, "package.json"));
    // UI is linked for resolution, but its browser dependency tree is not a server input.
    if (pkg.name === "@elizaos/ui") continue;
    for (const [name, version] of Object.entries(pkg.dependencies ?? {})) {
      const dependency = nameToDir.get(name);
      if (dependency) pending.push(dependency);
      else if (version.startsWith("workspace:")) {
        throw new Error(
          `Missing runtime workspace ${name} required by ${pkg.name}`,
        );
      }
    }
  }
  return [...visited];
}

// Native / desktop / GPU packages that the image deliberately removes or that
// cannot install in the slim Linux runtime. Excluding them keeps `npm
// install` from failing on optional native builds the agent never loads on
// boot. The image prunes @node-llama-cpp GPU variants and storybook after
// installation.
const EXCLUDE = new Set([
  // Desktop / Electron / Capacitor native shells (not used by the headless
  // server runtime).
  "@capacitor/core",
  "@capacitor/cli",
  "@capacitor-community/sqlite",
  "@capacitor/barcode-scanner",
  "@capacitor/haptics",
  "@capacitor/keyboard",
  "@capacitor/preferences",
  "@capacitor/push-notifications",
  "electrobun",
]);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

/**
 * Build a name -> exact-version map from bun.lock so deps pin reproducibly.
 * bun.lock is JSONC-ish (trailing commas); we only need the top-level
 * "packages" map whose entries look like:
 *   "name": ["name@version", "...", {...}, "sha..."]
 * We extract the version from the first array element.
 */
function loadLockVersions() {
  const lockPath = path.join(repoRoot, "bun.lock");
  const versions = new Map();
  let text;
  try {
    text = fs.readFileSync(lockPath, "utf8");
  } catch {
    return versions;
  }
  // Match:  "key": ["pkg@1.2.3", ...
  const re = /"([^"]+)":\s*\[\s*"((?:@[^"/]+\/)?[^"@/][^"@]*)@([^"]+)"/g;
  for (const match of text.matchAll(re)) {
    const declaredName = match[2];
    const version = match[3];
    // Keep the first (top-level) resolution for each package name. Nested
    // keys like "foo/bar" (a transitive dep of foo) are skipped so we pin to
    // the hoisted/top-level version the workspace actually builds against.
    if (!declaredName.includes("/") || declaredName.startsWith("@")) {
      if (!versions.has(declaredName)) {
        versions.set(declaredName, version);
      }
    }
  }
  return versions;
}

function isExternal(name) {
  return !name.startsWith("@elizaos/") && !EXCLUDE.has(name);
}

function main() {
  const asJson = process.argv.includes("--json");
  const namesOnly = process.argv.includes("--names");
  const lockVersions = loadLockVersions();
  // name -> Set of declared ranges (for diagnostics if unpinned)
  const collected = new Map();

  const workspaceDirs = collectDockerWorkspaceDirs();
  for (const directory of workspaceDirs) {
    const pkg = readJson(path.join(directory, "package.json"));
    if (pkg.name === "@elizaos/ui") continue;
    const deps = pkg.dependencies ?? {};
    for (const [name, range] of Object.entries(deps)) {
      if (!isExternal(name)) continue;
      if (typeof range === "string" && range.startsWith("workspace:")) continue;
      if (!collected.has(name)) collected.set(name, new Set());
      collected.get(name).add(range);
    }
  }

  const names = [...collected.keys()].sort();
  const specifiers = [];
  const unpinned = [];
  for (const name of names) {
    const exact = lockVersions.get(name);
    if (exact) {
      specifiers.push(`${name}@${exact}`);
    } else {
      // Fall back to a declared range (pick the first). npm will resolve it.
      const range = [...collected.get(name)][0];
      specifiers.push(`${name}@${range}`);
      unpinned.push(`${name} (${range})`);
    }
  }

  if (namesOnly) {
    process.stdout.write(`${names.join("\n")}\n`);
    return;
  }

  if (unpinned.length > 0) {
    process.stderr.write(
      `[collect-docker-runtime-deps] WARN: no lockfile pin for ${unpinned.length} dep(s); using declared range: ${unpinned.join(", ")}\n`,
    );
  }
  process.stderr.write(
    `[collect-docker-runtime-deps] ${specifiers.length} third-party runtime deps across ${workspaceDirs.length} linked packages\n`,
  );

  if (asJson) {
    process.stdout.write(`${JSON.stringify(specifiers, null, 2)}\n`);
  } else {
    process.stdout.write(`${specifiers.join("\n")}\n`);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
