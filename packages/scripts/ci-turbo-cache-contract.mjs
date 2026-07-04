#!/usr/bin/env node
/**
 * Contract for the GitHub-native Turbo cache migration (#12341). Guards the
 * one-way move off the Vercel remote cache (TURBO_TOKEN / TURBO_TEAM /
 * TURBO_CACHE: remote:rw) toward the pinned `turbo-cache-github` composite
 * action, so a workflow cannot silently straddle both regimes.
 *
 * Two invariants, checked statically against the checked-in YAML:
 *
 *   1. The GitHub-native shim exists and stays pinned. `turbo-cache-github`
 *      must be present, `using: composite`, key off the deterministic
 *      `turbo-cache-key.mjs` hash, and reference `actions/cache` by a full
 *      commit SHA (never a floating tag). The shim itself must carry no SaaS
 *      remote-cache env.
 *
 *   2. No workflow mixes regimes. Any workflow that ADOPTS the shim
 *      (`uses: ./.github/actions/turbo-cache-github`) must NOT also wire the
 *      SaaS remote cache env. Re-adding `TURBO_TOKEN`/`TURBO_TEAM`/
 *      `TURBO_CACHE: remote:rw` to a migrated workflow fails the contract.
 *
 * This contract is intentionally silent about workflows that still use the SaaS
 * remote cache and have NOT yet adopted the shim — those are migrated one at a
 * time under #12341, each removal proven safe on its own. The existing
 * `ci-workflow-dedup-contract.mjs` continues to pin the SaaS wiring that is
 * still live (nightly/release) until it is migrated.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const SHIM_PATH = ".github/actions/turbo-cache-github/action.yml";
const SHIM_USES = "./.github/actions/turbo-cache-github";
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
// (no process exit / no console) so tests can drive it against a fixture tree;
// throws on any violation and returns the list of adopting workflows on success.
export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

  // --- Invariant 1: the shim exists, is pinned, and carries no SaaS env. ---
  const shim = read(SHIM_PATH);
  assert(
    /using:\s*["']?composite["']?/.test(shim),
    `${SHIM_PATH}: must be a composite action (using: composite)`,
  );
  assert(
    shim.includes("turbo-cache-key.mjs"),
    `${SHIM_PATH}: must key off the deterministic turbo-cache-key hash`,
  );
  const cacheRef = shim.match(/actions\/cache@([^\s]+)/);
  assert(cacheRef !== null, `${SHIM_PATH}: must reference actions/cache`);
  assert(
    /^[0-9a-f]{40}$/.test(cacheRef[1]),
    `${SHIM_PATH}: actions/cache must be pinned to a full 40-char commit SHA, got "${cacheRef[1]}"`,
  );
  const shimSaas = firstSaasMarker(shim);
  assert(
    shimSaas === null,
    `${SHIM_PATH}: the GitHub-native shim must not wire the SaaS remote cache (found ${shimSaas})`,
  );

  // --- Invariant 2: no adopting workflow also wires the SaaS remote cache. ---
  const workflowFiles = readdirSync(resolve(repoRoot, WORKFLOW_DIR)).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );

  const adopters = [];
  for (const name of workflowFiles) {
    const rel = join(WORKFLOW_DIR, name);
    const text = read(rel);
    if (!text.includes(SHIM_USES)) continue;
    adopters.push(rel);
    const saas = firstSaasMarker(text);
    assert(
      saas === null,
      `${rel}: adopts the GitHub-native turbo cache shim but still wires the SaaS remote cache (${saas}). ` +
        "Pick one regime — remove the SaaS env.",
    );
  }

  return { adopters };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { adopters } = runContract();
    console.log(
      `ci turbo cache contract passed (shim pinned; ${adopters.length} adopting workflow(s), none mixing regimes)`,
    );
  } catch (error) {
    console.error(`[ci-turbo-cache-contract] FAIL ${error.message}`);
    process.exit(1);
  }
}
