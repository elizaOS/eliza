/**
 * Mutates real workflow YAML to prove merge-critical policy regressions fail.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { validateWorkflowSources } from "./ci-workflow-invariants.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const sources = {
  ciBunVersion: readFileSync(
    path.join(root, ".github/ci-bun-version.json"),
    "utf8",
  ),
  cloudSetup: readFileSync(
    path.join(root, ".github/actions/cloud-setup-test-env/action.yml"),
    "utf8",
  ),
  cloudTests: readFileSync(
    path.join(root, ".github/workflows/cloud-tests.yml"),
    "utf8",
  ),
  develop: readFileSync(
    path.join(root, ".github/workflows/develop-pr.yml"),
    "utf8",
  ),
  gitleaks: readFileSync(
    path.join(root, ".github/workflows/gitleaks.yml"),
    "utf8",
  ),
  qualityFork: readFileSync(
    path.join(root, ".github/workflows/quality-fork.yml"),
    "utf8",
  ),
  setupWorkspace: readFileSync(
    path.join(root, ".github/actions/setup-bun-workspace/action.yml"),
    "utf8",
  ),
  tests: readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8"),
};

test("accepts the repository workflow graph", () => {
  assert.deepEqual(validateWorkflowSources(sources), { ok: true });
});

for (const fixture of [
  {
    name: "generic runner admission for PostgreSQL e2e",
    key: "cloudTests",
    mutate: (source) =>
      source.replace(
        "    runs-on: ubuntu-24.04\n",
        "    runs-on: self-hosted\n",
      ),
    pattern: /must use the Docker-capable ubuntu-24.04 runner/,
  },
  {
    name: "late Docker capability preflight",
    key: "cloudSetup",
    mutate: (source) =>
      source.replace(
        "  steps:\n    - name: Verify PostgreSQL container runtime\n",
        '  steps:\n    - uses: actions/setup-node@v6\n      with:\n        node-version: "22"\n    - name: Verify PostgreSQL container runtime\n',
      ),
    pattern: /Docker daemon preflight must run before/,
  },
  {
    name: "Bun install archive cache",
    key: "cloudSetup",
    mutate: (source) =>
      source.replace(
        "    - name: Install dependencies\n",
        "    - uses: actions/cache@v5\n      with:\n        path: ~/.bun/install/cache\n        key: bun-Linux-global\n    - name: Install dependencies\n",
      ),
    pattern: /multi-gigabyte Bun install archives are prohibited/,
  },
  {
    name: "shared Bun executable installation",
    key: "cloudSetup",
    mutate: (source) => source.replace(/ {6}env:\n {8}HOME:.*\n/, ""),
    pattern: /setup-bun HOME must be isolated by run, attempt, and job/,
  },
  {
    name: "space-bearing runner name in Bun HOME",
    key: "cloudSetup",
    mutate: (source) =>
      source.replace(
        `-\${{ github.job }}\n`,
        `-\${{ github.job }}-\${{ runner.name }}\n`,
      ),
    pattern: /without space-bearing runner metadata/,
  },
  {
    name: "degraded Cloud e2e database backend",
    key: "cloudTests",
    mutate: (source) =>
      source.replace(
        '          db-backend: "postgres"\n',
        '          db-backend: "pglite"\n',
      ),
    pattern: /must explicitly request real PostgreSQL/,
  },
  {
    name: "skipped Cloud database migrations",
    key: "cloudSetup",
    mutate: (source) =>
      source.replace(
        "    - name: Run database migrations\n      if: inputs.setup-db == 'true'\n",
        "    - name: Run database migrations\n      if: false\n",
      ),
    pattern: /database migrations must remain fail-closed/,
  },
  {
    name: "persistent runner admission for fork validation",
    key: "qualityFork",
    mutate: (source) =>
      `${source}\n  future-fork-job:\n    if: github.event_name == 'workflow_dispatch'\n    runs-on: self-hosted\n    steps:\n      - run: true\n`,
    pattern:
      /jobs.future-fork-job must use the isolated ubuntu-24.04 hosted runner/,
  },
  {
    name: "divergent Bun version for fork validation",
    key: "ciBunVersion",
    mutate: (source) =>
      source.replace(/"version":\s*"\d+\.\d+\.\d+"/, '"version": "0.0.0"'),
    pattern: /fork validation must use the canonical CI Bun version/,
  },
  {
    name: "missing manual fork proof trigger",
    key: "qualityFork",
    mutate: (source) => source.replace("  workflow_dispatch:\n", ""),
    pattern: /workflow_dispatch must remain available for exact-head proof/,
  },
  {
    name: "fork job excluded from manual exact-head proof",
    key: "qualityFork",
    mutate: (source) =>
      source.replace(
        "    if: github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork == true)\n",
        "    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork == true\n",
      ),
    pattern: /jobs.lint must remain executable by workflow_dispatch/,
  },
  {
    name: "shared CLI Bun executable installation",
    key: "qualityFork",
    mutate: (source) =>
      source.replace(
        /      - name: Setup Bun\n([\s\S]*?) {8}env:\n {10}HOME:.*\n/,
        "      - name: Setup Bun\n$1",
      ),
    pattern: /CLI setup-bun HOME must be isolated by run, attempt, and job/,
  },
  {
    name: "misplaced workspace setup-bun HOME",
    key: "setupWorkspace",
    mutate: (source) =>
      source.replace(
        / {6}env:\n {8}# setup-bun installs[\s\S]*? {8}HOME:.*\n/,
        "",
      ),
    pattern: /setup-bun HOME must be isolated on the setup-bun step/,
  },
  {
    name: "conditional lint",
    key: "develop",
    mutate: (source) =>
      source.replace(
        "      - name: Run lint (read-only)\n",
        "      - name: Run lint (read-only)\n        if: false\n",
      ),
    pattern: /lint:check may not be conditional/,
  },
  {
    name: "permissive gitleaks",
    key: "gitleaks",
    mutate: (source) =>
      source.replace(
        "          gitleaks detect",
        "          gitleaks detect || true",
      ),
    pattern: /success-forcing/,
  },
  {
    name: "missing quality dependency",
    key: "tests",
    mutate: (source) => source.replace("      - merge-quality-gate\n", ""),
    pattern: /ci-ok must need merge-quality-gate/,
  },
  {
    name: "skipped script tests",
    key: "tests",
    mutate: (source) =>
      source.replace("  script-tests:\n", "  script-tests:\n    if: false\n"),
    pattern: /script-tests may not declare if/,
  },
]) {
  test(`rejects ${fixture.name}`, () => {
    const mutated = {
      ...sources,
      [fixture.key]: fixture.mutate(sources[fixture.key]),
    };
    assert.throws(() => validateWorkflowSources(mutated), fixture.pattern);
  });
}
