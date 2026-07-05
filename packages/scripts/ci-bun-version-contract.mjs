#!/usr/bin/env node
/**
 * Contract for the pinned CI Bun version (#13402 item 2 + item 5). Keeps the
 * frozen-lockfile install path on ONE concrete Bun version so a stale bump or a
 * regression back to floating `canary`/`latest` cannot slip through unnoticed.
 *
 * Background: `bun install --frozen-lockfile` fails when Bun reserializes
 * bun.lock to lockfileVersion 2, which floating `canary`/`latest` do on their
 * own cadence (#11184/#9454); the repo's packageManager `bun@1.4.0-canary.1` is
 * also unresolvable in CI. So the required test/build gates pin a concrete Bun
 * version rather than tracking the moving channel. The canonical value lives in
 * `.github/ci-bun-version.json` — GitHub Actions cannot interpolate a file into
 * `${{ }}` at parse time, so the literal is repeated in each workflow and this
 * contract is what guarantees those copies never drift from the source of truth.
 *
 * Two invariants, checked statically against the checked-in YAML (no workflow is
 * executed):
 *
 *   1. No divergent concrete pin. Every `bun-version:`/`BUN_VERSION:` value in
 *      `.github/workflows` that is a concrete version (a semver, not a `${{ }}`
 *      expression and not floating `canary`/`latest`) must equal the canonical
 *      version. This catches a second concrete pin drifting away from the rest.
 *
 *   2. The frozen-lockfile gate workflows stay pinned. Each workflow in
 *      GATE_WORKFLOWS — the required/scheduled lanes that run a frozen install —
 *      must wire the canonical pin (as a `BUN_VERSION`/`bun-version` literal) and
 *      must NOT wire floating `canary`/`latest`. This catches a regression that
 *      unpins a gate back onto the moving channel.
 *
 * Intentionally silent about non-gate workflows that track `canary`/`latest` on
 * purpose (benchmarks, some release/build lanes). Narrowing those is a separate
 * judgement call under #13402 item 2; this contract only locks the concrete-pin
 * source of truth and the frozen-install gates.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const VERSION_FILE = ".github/ci-bun-version.json";
const WORKFLOW_DIR = ".github/workflows";

// The frozen-lockfile install lanes that must stay on the concrete pin. Each
// documents the `--frozen-lockfile` rationale inline; the required `ci-ok`
// aggregate (test.yml) and the main gate (ci.yaml) are the load-bearing two.
const GATE_WORKFLOWS = [
  "ci.yaml",
  "test.yml",
  "develop-exhaustive.yml",
  "ci-full-matrix-proof.yml",
  "benchmark-tests.yml",
  "windows-desktop-preload-smoke.yml",
  "feed-env-audit.yml",
];

// A concrete pin: a plain semver, optionally with a prerelease/build suffix.
// `canary`, `latest`, and `${{ ... }}` expressions deliberately do not match.
const CONCRETE_PIN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;
const FLOATING = new Set(["canary", "latest"]);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

// Extract every `bun-version:`/`BUN_VERSION:` value wired in a workflow, as
// `{ key, raw }` with the inline comment and surrounding quotes stripped. Only
// real YAML key wiring counts — a version named in a `#` comment (e.g. the
// unresolvable `bun@1.4.0-canary.1` rationale) is never treated as a pin.
function bunVersionValues(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const match = line.match(
      /^\s*(?:-\s+)?(bun-version|BUN_VERSION):\s*(.+?)\s*$/,
    );
    if (!match) continue;
    let raw = match[2].replace(/\s+#.*$/, "").trim();
    if (raw.startsWith('"') || raw.startsWith("'")) {
      raw = raw.slice(1, -1);
    }
    out.push({ key: match[1], raw });
  }
  return out;
}

function isExpression(raw) {
  return raw.includes("${{");
}

// Validate both invariants against a repo layout rooted at `repoRoot`. Pure
// (no process exit / no console) so tests can drive it against fixture trees;
// throws on the first violation, returns the canonical version and the scanned
// concrete-pin sites on success.
export function runContract(repoRoot = DEFAULT_REPO_ROOT) {
  const read = (rel) => readFileSync(resolve(repoRoot, rel), "utf8");

  const manifest = JSON.parse(read(VERSION_FILE));
  const canonical = manifest.version;
  assert(
    typeof canonical === "string" && CONCRETE_PIN.test(canonical),
    `${VERSION_FILE}: "version" must be a concrete Bun pin (semver), got ${JSON.stringify(canonical)}`,
  );
  assert(
    !FLOATING.has(canonical),
    `${VERSION_FILE}: "version" must not float (${canonical})`,
  );

  const workflowFiles = readdirSync(resolve(repoRoot, WORKFLOW_DIR)).filter(
    (name) => name.endsWith(".yml") || name.endsWith(".yaml"),
  );

  // --- Invariant 1: no concrete pin diverges from the source of truth. ---
  const concretePins = [];
  for (const name of workflowFiles) {
    const rel = join(WORKFLOW_DIR, name);
    for (const { raw } of bunVersionValues(read(rel))) {
      if (isExpression(raw) || FLOATING.has(raw) || !CONCRETE_PIN.test(raw)) {
        continue;
      }
      assert(
        raw === canonical,
        `${rel}: pins Bun ${raw}, but the canonical CI Bun version is ${canonical} ` +
          `(${VERSION_FILE}). Update this workflow or bump the source of truth — keep them in lockstep.`,
      );
      concretePins.push({ workflow: rel, version: raw });
    }
  }

  // --- Invariant 2: the frozen-install gate lanes stay pinned. ---
  for (const name of GATE_WORKFLOWS) {
    const rel = join(WORKFLOW_DIR, name);
    const text = read(rel);
    const values = bunVersionValues(text);

    const floats = values.find(
      (v) => !isExpression(v.raw) && FLOATING.has(v.raw),
    );
    assert(
      floats === undefined,
      `${rel}: is a frozen-lockfile gate but wires floating Bun "${floats?.raw}". ` +
        `It must stay pinned to ${canonical} (${VERSION_FILE}) so --frozen-lockfile does not break.`,
    );

    const pinsCanonical = values.some((v) => v.raw === canonical);
    assert(
      pinsCanonical,
      `${rel}: is a frozen-lockfile gate but does not wire the canonical Bun pin ${canonical} ` +
        `(${VERSION_FILE}). Expected a BUN_VERSION/bun-version: "${canonical}" literal.`,
    );
  }

  return { canonical, concretePins, gateWorkflows: GATE_WORKFLOWS };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const { canonical, concretePins, gateWorkflows } = runContract();
    console.log(
      `ci bun version contract passed (canonical ${canonical}; ` +
        `${concretePins.length} concrete pin(s) in lockstep; ${gateWorkflows.length} gate lane(s) pinned)`,
    );
  } catch (error) {
    console.error(`[ci-bun-version-contract] FAIL ${error.message}`);
    process.exit(1);
  }
}
