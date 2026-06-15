#!/usr/bin/env node
/**
 * Collect the third-party (non-@elizaos) runtime dependency closure for the
 * agent Docker image.
 *
 * Background: the CI image (deploy/Dockerfile.ci) ships pre-transpiled
 * artifacts and links a fixed set of workspace packages into
 * /app/node_modules (see link-docker-local-app-packages.mjs). Some of those
 * packages are transpiled (tsc, not bundled), so their bare third-party imports
 * stay external and must resolve from node_modules at runtime; others are
 * bundled with a small third-partys list. The image used to install a
 * hand-maintained allowlist of those third-partys, which had to be extended by
 * hand every time a newly-linked package pulled in a new dependency, causing
 * repeated boot-crash / rebuild loops.
 *
 * This script replaces that hand-maintained list with a DERIVED one: it reads
 * the declared `dependencies` of every workspace package that is linked into
 * the image, drops the workspace (@elizaos/*) entries (those are linked
 * separately, not installed from the registry), and emits the union as
 * `name@version` install specifiers. `npm install` then resolves the full
 * transitive closure automatically.
 *
 * Versions: each dependency is pinned to the exact version the workspace
 * lockfile resolves (bun.lock), falling back to the declared range when the
 * lockfile cannot be read. This keeps the image build reproducible.
 *
 * Usage:
 *   node collect-docker-runtime-deps.mjs            # prints `name@version`, one per line
 *   node collect-docker-runtime-deps.mjs --json     # prints a JSON array
 *   node collect-docker-runtime-deps.mjs --names    # prints bare names, one per line
 *                                                   # (for pre-clean rm -rf)
 *
 * The set of linked packages MUST stay in sync with the `localPackages`
 * array in link-docker-local-app-packages.mjs. It is duplicated here (rather
 * than imported) because that module performs filesystem linking as a side
 * effect at import time.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/ -> app-core -> packages -> repo root
const repoRoot = path.resolve(__dirname, "..", "..", "..");

// Workspace packages linked into the image by
// link-docker-local-app-packages.mjs. The agent entrypoint package itself is
// relinked separately (relink-workspace-packages-to-dist.mjs @elizaos/agent),
// so include it here too so its declared deps are part of the closure.
//
// NOTE: @elizaos/ui is intentionally excluded. It is linked into the image
// for module-resolution integrity, but it is a pure browser/React package
// (radix-ui, three, recharts, react-router, ...). The headless server
// runtime never imports its components; the dashboard ships as pre-built
// static assets. Installing its ~50 frontend deps would massively bloat the
// image (and pull native/canvas deps) for code that is never evaluated on
// the boot or request path.
const LINKED_WORKSPACE_PACKAGES = [
  "packages/agent",
  "packages/core",
  "packages/contracts",
  "packages/cloud-routing",
  "packages/app-core",
  "packages/cloud-sdk",
  "packages/shared",
  "packages/skills",
  "packages/vault",
  // Imported by packages/agent/src/services/remote-plugin-bridge.ts
  // ("@elizaos/plugin-worker-runtime/error"). The custom-character boot path
  // goes through remote-plugin-bridge, so without this the container crashes
  // with ERR_MODULE_NOT_FOUND on plugin-worker-runtime/dist/index.js whenever
  // an injected character (ELIZA_AGENT_CHARACTER_JSON) is loaded.
  "packages/plugin-worker-runtime",
  "plugins/plugin-companion",
  "plugins/plugin-elizamaker",
  "plugins/plugin-documents",
  "plugins/plugin-personal-assistant",
  "plugins/plugin-steward-app",
  "plugins/plugin-task-coordinator",
  "plugins/plugin-training",
  "plugins/plugin-shopify-ui",
  "plugins/plugin-vincent",
  "plugins/plugin-agent-skills",
  "plugins/plugin-app-manager",
  "plugins/plugin-browser",
  "plugins/plugin-capacitor-bridge",
  "plugins/plugin-coding-tools",
  "plugins/plugin-computeruse",
  "plugins/plugin-discord",
  "plugins/plugin-elizacloud",
  "plugins/plugin-imessage",
  "plugins/plugin-local-inference",
  "plugins/plugin-mcp",
  "plugins/plugin-pdf",
  "plugins/plugin-signal",
  "plugins/plugin-streaming",
  "plugins/plugin-native-activity-tracker",
  "plugins/plugin-sql",
  "plugins/plugin-telegram",
  "plugins/plugin-video",
  "plugins/plugin-wallet",
  "plugins/plugin-whatsapp",
  "plugins/plugin-workflow",
  "plugins/plugin-x402",
];

// Native / desktop / GPU packages that the image deliberately removes or that
// cannot install in the slim Linux runtime. Excluding them keeps `npm
// install` from failing on optional native builds the agent never loads on
// boot. (The image already prunes @node-llama-cpp GPU variants, storybook,
// and the desktop-only orchestrator.)
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

  for (const rel of LINKED_WORKSPACE_PACKAGES) {
    const pkgJsonPath = path.join(repoRoot, rel, "package.json");
    let pkg;
    try {
      pkg = readJson(pkgJsonPath);
    } catch {
      // A package listed for linking may not exist in every checkout; skip.
      continue;
    }
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
    `[collect-docker-runtime-deps] ${specifiers.length} third-party runtime deps across ${LINKED_WORKSPACE_PACKAGES.length} linked packages\n`,
  );

  if (asJson) {
    process.stdout.write(`${JSON.stringify(specifiers, null, 2)}\n`);
  } else {
    process.stdout.write(`${specifiers.join("\n")}\n`);
  }
}

main();
