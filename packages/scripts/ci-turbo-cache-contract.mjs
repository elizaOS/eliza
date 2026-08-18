#!/usr/bin/env node
/**
 * Contract for the GitHub-native Turbo cache migration (#12341). Guards the
 * one-way move off the Vercel remote cache (TURBO_TOKEN / TURBO_TEAM /
 * TURBO_CACHE: remote:rw) to the cache embedded in setup-bun-workspace.
 *
 * Two invariants, checked statically against the checked-in YAML:
 *
 *   1. setup-bun-workspace is a composite action, keys off the deterministic
 *      `turbo-cache-key.mjs` hash, and references `actions/cache` by a full
 *      commit SHA (never a floating tag).
 *
 *   2. No workflow or the shared setup action wires the SaaS remote-cache env.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SETUP_WORKSPACE_PATH = ".github/actions/setup-bun-workspace/action.yml";
const WORKFLOW_DIR = ".github/workflows";

// Match the SaaS remote-cache env as actual YAML wiring — a key followed by a
// value — not prose that merely names it. `TURBO_TOKEN: ${{ secrets... }}`,
// `TURBO_TEAM: ${{ vars... }}`, and `TURBO_CACHE: remote:rw` are wiring; a
// sentence mentioning TURBO_TOKEN in a description is not.
const SAAS_MARKERS = [
  { label: "TURBO_TOKEN", pattern: /\bTURBO_TOKEN:\s*\$\{\{/ },
  { label: "TURBO_TEAM", pattern: /\bTURBO_TEAM:\s*\$\{\{/ },
  { label: "TURBO_CACHE: remote", pattern: /\bTURBO_CACHE:\s*remote:/ },
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function firstSaasMarker(text) {
  return SAAS_MARKERS.find(({ pattern }) => pattern.test(text))?.label ?? null;
}

// Validate the two invariants against a repo layout rooted at `repoRoot`. Pure
// (no process exit / no console) so tests can drive it against a fixture tree.
export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

  const workspaceSetup = read(SETUP_WORKSPACE_PATH);
  assert(
    /using:\s*["']?composite["']?/.test(workspaceSetup),
    `${SETUP_WORKSPACE_PATH}: must be a composite action (using: composite)`,
  );
  assert(
    workspaceSetup.includes("turbo-cache-key.mjs"),
    `${SETUP_WORKSPACE_PATH}: must key off the deterministic turbo-cache-key hash`,
  );
  const cacheRef = workspaceSetup.match(/actions\/cache@([^\s]+)/);
  assert(
    cacheRef !== null,
    `${SETUP_WORKSPACE_PATH}: must reference actions/cache`,
  );
  assert(
    /^[0-9a-f]{40}$/.test(cacheRef[1]),
    `${SETUP_WORKSPACE_PATH}: actions/cache must be pinned to a full 40-char commit SHA, got "${cacheRef[1]}"`,
  );
  const setupSaas = firstSaasMarker(workspaceSetup);
  assert(
    setupSaas === null,
    `${SETUP_WORKSPACE_PATH}: must not wire the SaaS remote cache (found ${setupSaas})`,
  );

  assert(
    /actions\/cache@[0-9a-f]{40}/.test(workspaceSetup),
    `${SETUP_WORKSPACE_PATH}: must invoke a pinned actions/cache directly`,
  );
  assert(
    /path:\s*\.turbo/.test(workspaceSetup),
    `${SETUP_WORKSPACE_PATH}: actions/cache must persist .turbo`,
  );
  assert(
    /key:\s*turbo-.*\$\{\{\s*github\.job\s*\}\}/.test(workspaceSetup),
    `${SETUP_WORKSPACE_PATH}: primary cache key must be lane-scoped with github.job`,
  );
  assert(
    /restore-keys:[\s\S]*turbo-\$\{\{\s*runner\.os\s*\}\}-\$\{\{\s*steps\.turbo-key\.outputs\.turbo_cache_key\s*\}\}-/.test(
      workspaceSetup,
    ),
    `${SETUP_WORKSPACE_PATH}: must retain the deterministic cross-lane restore prefix`,
  );
  assert(
    /name:\s*Setup Bun[\s\S]*?HOME:\s*\$\{\{\s*runner\.temp\s*\}\}\/bun-home-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}-\$\{\{\s*github\.job\s*\}\}-\$\{\{\s*strategy\.job-index\s*\|\|\s*0\s*\}\}\s*[\r\n]+[\s\S]*?USERPROFILE:\s*\$\{\{\s*runner\.temp\s*\}\}\/bun-home-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}-\$\{\{\s*github\.job\s*\}\}-\$\{\{\s*strategy\.job-index\s*\|\|\s*0\s*\}\}\s*[\r\n]+[\s\S]*?bun-version:[\s\S]*?no-cache:\s*true/.test(
      workspaceSetup,
    ),
    `${SETUP_WORKSPACE_PATH}: setup-bun home must be isolated by run, attempt, job, matrix entry, and OS without caching the ephemeral executable path or using space-bearing runner metadata`,
  );

  const workflowFiles = readdirSync(resolve(repoRoot, WORKFLOW_DIR)).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );

  for (const name of workflowFiles) {
    const rel = join(WORKFLOW_DIR, name);
    const text = read(rel);
    const saas = firstSaasMarker(text);
    assert(
      saas === null,
      `${rel}: must not wire the SaaS remote cache (${saas})`,
    );
  }

  return { workflowCount: workflowFiles.length };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const { workflowCount } = runContract();
    console.log(
      `ci turbo cache contract passed (shared cache pinned; ${workflowCount} workflow(s) use no SaaS cache)`,
    );
  } catch (error) {
    console.error(`[ci-turbo-cache-contract] FAIL ${error.message}`);
    process.exit(1);
  }
}
