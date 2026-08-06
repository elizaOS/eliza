/**
 * Mutates real workflow YAML to prove merge-critical policy regressions fail.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { run, validateWorkflowSources } from "./ci-workflow-invariants.mjs";

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
  nightly: readFileSync(
    path.join(root, ".github/workflows/nightly.yml"),
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
  skillRequirements: readFileSync(
    path.join(root, "packages/skills/skills/skill-creator/requirements.txt"),
    "utf8",
  ),
  tests: readFileSync(path.join(root, ".github/workflows/test.yml"), "utf8"),
};

test("accepts the repository workflow graph", () => {
  assert.deepEqual(validateWorkflowSources(sources), { ok: true });
});

test("loads every repository workflow source from disk", () => {
  assert.deepEqual(run(root), { ok: true });
});

for (const fixture of [
  {
    name: "Nightly root build without Python 3.13",
    key: "nightly",
    mutate: (source) =>
      source.replace('          python-version: "3.13"\n', ""),
    pattern: /must provision Python 3.13 on the fail-closed hosted runner/,
  },
  {
    name: "Nightly root build on a fail-open self-hosted runner",
    key: "nightly",
    mutate: (source) =>
      source.replace(
        "    runs-on: ubuntu-24.04\n",
        "    runs-on: self-hosted\n",
      ),
    pattern: /must provision Python 3.13 on the fail-closed hosted runner/,
  },
  {
    name: "Nightly Windows build without Python 3.13",
    key: "nightly",
    mutate: (source) =>
      source.replace(
        '        uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97\n        with:\n          python-version: "3.13"\n',
        '        uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97\n        with:\n          python-version: "3.12"\n',
      ),
    pattern: /every desktop build lane must provision Python 3.13/,
  },
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
    mutate: (source) => source.replace(/ {8}USERPROFILE:.*\n/, ""),
    pattern:
      /setup-bun home must be isolated by run, attempt, job, matrix entry, and OS/,
  },
  {
    name: "space-bearing runner name in Bun HOME",
    key: "cloudSetup",
    mutate: (source) =>
      source.replace(`\${{ strategy.job-index || 0 }}`, `\${{ runner.name }}`),
    pattern:
      /setup-bun home must be isolated by run, attempt, job, matrix entry, and OS/,
  },
  {
    name: "matrix jobs share a Bun home",
    key: "cloudSetup",
    mutate: (source) =>
      source.replaceAll(`-\${{ strategy.job-index || 0 }}`, ""),
    pattern:
      /setup-bun home must be isolated by run, attempt, job, matrix entry, and OS/,
  },
  {
    name: "ephemeral cloud Bun executable path is cached",
    key: "cloudSetup",
    mutate: (source) => source.replace("        no-cache: true\n", ""),
    pattern: /without caching the ephemeral executable path/,
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
    name: "manual proof shares pull request concurrency",
    key: "qualityFork",
    mutate: (source) =>
      source.replace(
        `quality-fork-\${{ github.event_name }}-\${{ github.event.pull_request.number || github.ref }}`,
        `quality-fork-\${{ github.ref }}`,
      ),
    pattern:
      /manual exact-head proof must not share a concurrency group with pull request events/,
  },
  {
    name: "fork job excluded from manual exact-head proof",
    key: "qualityFork",
    mutate: (source) =>
      source.replace(
        "    if: github.event_name == 'workflow_dispatch' || (github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork == true)\n",
        "    if: github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork == true\n",
      ),
    pattern:
      /jobs.lint must run only for workflow_dispatch or fork pull requests/,
  },
  {
    name: "same-repository pull request admitted to fork validation",
    key: "qualityFork",
    mutate: (source) =>
      source.replace(
        "github.event.pull_request.head.repo.fork == true",
        "github.event_name == 'pull_request'",
      ),
    pattern:
      /jobs.lint must run only for workflow_dispatch or fork pull requests/,
  },
  {
    name: "missing hosted-build skill validator dependency",
    key: "qualityFork",
    mutate: (source) =>
      source.replace(
        "      - name: Install pinned skill validator dependency\n",
        "      - name: Omit pinned skill validator dependency\n",
      ),
    pattern:
      /hosted build must install the hash-pinned Python 3.13 skill validator dependency/,
  },
  {
    name: "legacy artifact sync for fork homepage validation",
    key: "qualityFork",
    mutate: (source) =>
      source.replace(
        '          ELIZA_SKIP_ARTIFACT_SYNC: "1"\n',
        '          ELIZA_SKIP_ARTIFACT_SYNC: "0"\n',
      ),
    pattern:
      /hosted build must preserve exact-head homepage baselines by skipping legacy artifact sync/,
  },
  {
    name: "unhashed hosted-build skill validator dependency",
    key: "qualityFork",
    mutate: (source) => source.replace(" --require-hashes", ""),
    pattern:
      /hosted build must install the hash-pinned Python 3.13 skill validator dependency/,
  },
  {
    name: "unapproved shared skill validator wheel",
    key: "skillRequirements",
    mutate: (source) =>
      source.replace(
        "0f29edc409a6392443abf94b9cf89ce99889a1dd5376d94316ae5145dfedd5d6",
        "0000000000000000000000000000000000000000000000000000000000000000",
      ),
    pattern: /must pin the approved Python 3.13 PyYAML wheel hash/,
  },
  {
    name: "mismatched hosted-build skill validator Python",
    key: "qualityFork",
    mutate: (source) =>
      source.replace(
        '          python-version: "3.13"\n',
        '          python-version: "3.12"\n',
      ),
    pattern:
      /hosted build must install the hash-pinned Python 3.13 skill validator dependency/,
  },
  {
    name: "shared CLI Bun executable installation",
    key: "qualityFork",
    mutate: (source) => source.replace(/ {10}USERPROFILE:.*\n/, ""),
    pattern:
      /CLI setup-bun home must be isolated by run, attempt, job, matrix entry, and OS/,
  },
  {
    name: "ephemeral CLI Bun executable path is cached",
    key: "qualityFork",
    mutate: (source) => source.replace("          no-cache: true\n", ""),
    pattern: /without caching the ephemeral executable path/,
  },
  {
    name: "misplaced workspace setup-bun HOME",
    key: "setupWorkspace",
    mutate: (source) => source.replace(/ {8}USERPROFILE:.*\n/, ""),
    pattern:
      /setup-bun home must be isolated on the setup-bun step for every matrix entry and OS/,
  },
  {
    name: "ephemeral workspace Bun executable path is cached",
    key: "setupWorkspace",
    mutate: (source) => source.replace("        no-cache: true\n", ""),
    pattern: /without caching the ephemeral executable path/,
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
    name: "repository-level plugin contracts treated as a workspace",
    key: "develop",
    mutate: (source) =>
      source.replace("__tests__/*) continue ;;", "__tests__/*) : ;;"),
    pattern: /exclude repository-level and fully deleted plugin roots/,
  },
  {
    name: "repository-level plugin build file treated as a workspace",
    key: "develop",
    mutate: (source) =>
      source.replace('if [[ "$relative" != */* ]]', "if false"),
    pattern: /exclude repository-level and fully deleted plugin roots/,
  },
  {
    name: "fully deleted legacy plugin treated as a current workspace",
    key: "develop",
    mutate: (source) =>
      source.replace('if [ ! -e "plugins/$pkg" ]', "if false"),
    pattern: /exclude repository-level and fully deleted plugin roots/,
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
