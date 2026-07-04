// Pins the workflow-dedup + GitHub-native cache contract (#10096/#12341)
// against synthetic repo trees: the branch-split fixtures pass, re-adding the
// Vercel SaaS remote-cache env fails, and a publish path that drops the
// GitHub-native cache fails. Also runs the shipped contract against the real
// repo so the guard stays true as the migration proceeds. Deterministic — no
// workflow is executed.
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract, findSaasRemoteCache } = await import(
  new URL("../ci-workflow-dedup-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// Minimal but valid branch-split fixtures. Formatting matches what the
// contract's inline-branches parser expects (`  <event>:` then
// `    branches: [...]`).
const CI_YAML = `name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./.github/actions/setup-bun-workspace
`;

const TEST_YML = `name: Tests
on:
  push:
    branches: [develop]
  pull_request:
    branches: [develop]
  merge_group:
    branches: [develop]
jobs:
  ci-ok:
    name: ci-ok
    runs-on: ubuntu-24.04
    steps:
      - run: |
          if [ "\${GITHUB_EVENT_NAME}" = "merge_group" ]; then
            echo bypass
          fi
`;

const SCENARIO_PR_YML = `name: Scenario PR
on:
  pull_request:
    branches: [main, develop]
jobs:
  x:
    runs-on: ubuntu-24.04
    steps:
      - run: echo ok
`;

const NIGHTLY_YML = `name: Nightly
on:
  schedule:
    - cron: "0 4 * * *"
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./.github/actions/setup-bun-workspace
`;

const RELEASE_YAML = `name: Release
on:
  workflow_dispatch:
jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./.github/actions/setup-bun-workspace
`;

function baseWorkflows() {
  return {
    "ci.yaml": CI_YAML,
    "test.yml": TEST_YML,
    "scenario-pr.yml": SCENARIO_PR_YML,
    "nightly.yml": NIGHTLY_YML,
    "release.yaml": RELEASE_YAML,
  };
}

function buildRepo(workflows) {
  const root = mkdtempSync(join(tmpdir(), "dedup-contract-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  for (const [name, content] of Object.entries(workflows)) {
    writeFileSync(join(root, ".github", "workflows", name), content);
  }
  return root;
}

function withRepo(workflows, fn) {
  const root = buildRepo(workflows);
  try {
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("ci-workflow-dedup-contract", () => {
  test("a clean branch-split repo with no SaaS env passes", () => {
    withRepo(baseWorkflows(), (root) => {
      expect(runContract(root)).toEqual({ ok: true });
    });
  });

  test("re-adding the SaaS remote cache to any workflow fails the contract", () => {
    const workflows = baseWorkflows();
    workflows["scenario-pr.yml"] = SCENARIO_PR_YML.replace(
      "  x:",
      "  x:\n    env:\n      TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}",
    );
    withRepo(workflows, (root) => {
      expect(() => runContract(root)).toThrow(/SaaS Turbo remote cache is banned/);
    });
  });

  test("a publish path that drops the GitHub-native cache fails the contract", () => {
    const workflows = baseWorkflows();
    workflows["nightly.yml"] = NIGHTLY_YML.replace(
      "      - uses: ./.github/actions/setup-bun-workspace",
      "      - run: echo no-cache",
    );
    withRepo(workflows, (root) => {
      expect(() => runContract(root)).toThrow(/GitHub-native turbo cache/);
    });
  });

  test("findSaasRemoteCache reports the offending file + marker", () => {
    const workflows = baseWorkflows();
    workflows["release.yaml"] = RELEASE_YAML.replace(
      "  publish:",
      "  publish:\n    env:\n      TURBO_CACHE: remote:rw",
    );
    withRepo(workflows, (root) => {
      const hits = findSaasRemoteCache(root);
      expect(hits).toEqual([
        { file: ".github/workflows/release.yaml", label: "TURBO_CACHE: remote" },
      ]);
    });
  });

  test("the real repo satisfies the contract (branch split + no SaaS)", () => {
    expect(runContract(REAL_REPO_ROOT)).toEqual({ ok: true });
    expect(findSaasRemoteCache(REAL_REPO_ROOT)).toEqual([]);
  });
});
