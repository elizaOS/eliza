// Pins the GitHub-native Turbo cache contract (#12341) against synthetic repo
// trees: the canonical shared setup passes, re-adding the Vercel SaaS cache
// anywhere fails, and an unpinned/floating actions/cache ref fails. Also runs
// the shipped contract against the real repo. Deterministic — no workflow runs.
import { describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract } = await import(
  new URL("../ci-turbo-cache-contract.mjs", import.meta.url).href
);

const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CI_BUN_VERSION = JSON.parse(
  readFileSync(join(REAL_REPO_ROOT, ".github", "ci-bun-version.json"), "utf8"),
).version;

const WORKSPACE_SETUP_YAML = `name: "Setup Bun Workspace"
runs:
  using: "composite"
  steps:
    - name: Compute deterministic Turbo cache key
      id: turbo-key
      shell: bash
      run: node packages/scripts/turbo-cache-key.mjs --github-output
    - name: Restore and save Turbo cache
      uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9
      with:
        path: .turbo
        key: turbo-\${{ runner.os }}-\${{ steps.turbo-key.outputs.turbo_cache_key }}-\${{ github.job }}
        restore-keys: |
          turbo-\${{ runner.os }}-\${{ steps.turbo-key.outputs.turbo_cache_key }}-
          turbo-\${{ runner.os }}-
    - name: Setup Bun
      uses: oven-sh/setup-bun@v2
      env:
        HOME: \${{ runner.temp }}/bun-home-\${{ github.run_id }}-\${{ github.run_attempt }}-\${{ github.job }}-\${{ strategy.job-index || 0 }}
        USERPROFILE: \${{ runner.temp }}/bun-home-\${{ github.run_id }}-\${{ github.run_attempt }}-\${{ github.job }}-\${{ strategy.job-index || 0 }}
      with:
        bun-version: 1.3.14
        no-cache: true
`;

const CLEAN_WORKFLOW = `name: Clean workflow
on: [workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./.github/actions/setup-bun-workspace
      - run: bun run build
`;

const SAAS_READDER = `name: Regressing workflow
on: [workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}
      TURBO_TEAM: \${{ vars.TURBO_TEAM }}
      TURBO_CACHE: remote:rw
    steps:
      - uses: ./.github/actions/setup-bun-workspace
      - run: bun run build
`;

function buildRepo({
  workspaceSetup = WORKSPACE_SETUP_YAML,
  workflows = {},
}) {
  const root = mkdtempSync(join(tmpdir(), "turbo-cache-contract-"));
  mkdirSync(join(root, ".github", "actions", "setup-bun-workspace"), {
    recursive: true,
  });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "actions", "setup-bun-workspace", "action.yml"),
    workspaceSetup,
  );
  for (const [name, content] of Object.entries(workflows)) {
    writeFileSync(join(root, ".github", "workflows", name), content);
  }
  return root;
}

describe("ci-turbo-cache-contract", () => {
  test("passes the canonical shared setup with no SaaS env", () => {
    const root = buildRepo({ workflows: { "clean.yml": CLEAN_WORKFLOW } });
    try {
      expect(runContract(root)).toEqual({ workflowCount: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when any workflow re-adds the SaaS remote cache env", () => {
    const root = buildRepo({ workflows: { "regress.yml": SAAS_READDER } });
    try {
      expect(() => runContract(root)).toThrow(
        /must not wire the SaaS remote cache/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when actions/cache is not pinned to a full commit SHA", () => {
    const floatingSetup = WORKSPACE_SETUP_YAML.replace(
      "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      "actions/cache@v4",
    );
    const root = buildRepo({
      workspaceSetup: floatingSetup,
      workflows: { "clean.yml": CLEAN_WORKFLOW },
    });
    try {
      expect(() => runContract(root)).toThrow(
        /pinned to a full 40-char commit SHA/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when workspace setup wires the SaaS remote cache", () => {
    const dirtySetup = WORKSPACE_SETUP_YAML.replace(
      "  steps:",
      "  env:\n    TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}\n  steps:",
    );
    const root = buildRepo({ workspaceSetup: dirtySetup });
    try {
      expect(() => runContract(root)).toThrow(
        /must not wire the SaaS remote cache/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when workspace setup drops the deterministic cache key", () => {
    const unkeyedSetup = WORKSPACE_SETUP_YAML.replace(
      "run: node packages/scripts/turbo-cache-key.mjs --github-output",
      "run: echo no-key",
    );
    const root = buildRepo({ workspaceSetup: unkeyedSetup });
    try {
      expect(() => runContract(root)).toThrow(
        /must key off the deterministic turbo-cache-key hash/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when concurrent lanes share one immutable primary key", () => {
    const unscopedSetup = WORKSPACE_SETUP_YAML.replace(
      "-${{ github.job }}",
      "",
    );
    const root = buildRepo({ workspaceSetup: unscopedSetup });
    try {
      expect(() => runContract(root)).toThrow(
        /primary cache key must be lane-scoped with github.job/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when setup-bun shares a host HOME across concurrent jobs", () => {
    const sharedHomeSetup = WORKSPACE_SETUP_YAML.replace(
      / {8}USERPROFILE:.*\n/,
      "",
    );
    const root = buildRepo({ workspaceSetup: sharedHomeSetup });
    try {
      expect(() => runContract(root)).toThrow(
        /setup-bun home must be isolated by run, attempt, job, matrix entry, and OS/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when setup-bun HOME includes human-readable runner metadata", () => {
    const unsafeHomeSetup = WORKSPACE_SETUP_YAML.replace(
      `\${{ strategy.job-index || 0 }}`,
      `\${{ runner.name }}`,
    );
    const root = buildRepo({ workspaceSetup: unsafeHomeSetup });
    try {
      expect(() => runContract(root)).toThrow(/space-bearing runner metadata/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when setup-bun shares a home across matrix entries", () => {
    const sharedMatrixHomeSetup = WORKSPACE_SETUP_YAML.replaceAll(
      `-\${{ strategy.job-index || 0 }}`,
      "",
    );
    const root = buildRepo({ workspaceSetup: sharedMatrixHomeSetup });
    try {
      expect(() => runContract(root)).toThrow(
        /setup-bun home must be isolated by run, attempt, job, matrix entry, and OS/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when setup-bun caches an ephemeral executable path", () => {
    const cachedEphemeralHomeSetup = WORKSPACE_SETUP_YAML.replace(
      "        no-cache: true\n",
      "",
    );
    const root = buildRepo({ workspaceSetup: cachedEphemeralHomeSetup });
    try {
      expect(() => runContract(root)).toThrow(
        /without caching the ephemeral executable path/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the fork lint lane keeps required gates with a bounded cold allowance", () => {
    const workflow = readFileSync(
      join(REAL_REPO_ROOT, ".github", "workflows", "quality-fork.yml"),
      "utf8",
    );
    const lintJob = workflow.match(
      /^ {2}lint:\s*$([\s\S]*?)(?=^ {2}typecheck:\s*$)/m,
    )?.[0];
    expect(lintJob).toBeDefined();
    expect(lintJob).toMatch(/timeout-minutes:\s*15/);
    for (const command of [
      "audit:focused-tests",
      "audit:type-duplication:self-test",
      "bun run lint:check",
      "bun run format:check",
    ]) {
      expect(lintJob).toContain(command);
    }
    expect(lintJob).not.toMatch(/continue-on-error/);
    expect(workflow).toContain(`BUN_VERSION: "${CI_BUN_VERSION}"`);
    expect(workflow).toMatch(
      /name:\s*Setup Bun[\s\S]*?HOME:\s*\$\{\{\s*runner\.temp\s*\}\}\/bun-home-\$\{\{\s*github\.run_id\s*\}\}-\$\{\{\s*github\.run_attempt\s*\}\}-\$\{\{\s*github\.job\s*\}\}-\$\{\{\s*strategy\.job-index\s*\|\|\s*0\s*\}\}\s*[\r\n]+[\s\S]*?USERPROFILE:/,
    );
  });

  test("the fork typecheck keeps full coverage with a bounded cold-cache allowance", () => {
    const workflow = readFileSync(
      join(REAL_REPO_ROOT, ".github", "workflows", "quality-fork.yml"),
      "utf8",
    );
    const typecheckJob = workflow.match(
      /^ {2}typecheck:\s*$([\s\S]*?)(?=^ {2}build:\s*$)/m,
    )?.[0];
    expect(typecheckJob).toBeDefined();
    expect(typecheckJob).toMatch(/timeout-minutes:\s*25/);
    expect(typecheckJob).toMatch(
      /run:\s*NODE_OPTIONS='--max-old-space-size=8192' node packages\/scripts\/run-turbo\.mjs run typecheck --concurrency=4/,
    );
    expect(typecheckJob).not.toMatch(/continue-on-error|\|\| true/);
  });

  test("the long cold lanes avoid stale Bun fallback restores", () => {
    const workflow = readFileSync(
      join(REAL_REPO_ROOT, ".github", "workflows", "quality-fork.yml"),
      "utf8",
    );
    const typecheckJob = workflow.match(
      /^ {2}typecheck:\s*$([\s\S]*?)(?=^ {2}build:\s*$)/m,
    )?.[0];
    const buildJob = workflow.match(
      /^ {2}build:\s*$([\s\S]*?)(?=^ {2}elizaos-cli-global-smoke:\s*$)/m,
    )?.[0];
    expect(typecheckJob).toMatch(/cache-bun-install:\s*["']false["']/);
    expect(buildJob).toMatch(/cache-bun-install:\s*["']false["']/);
    // 45m ceiling is deliberate: quality-fork.yml documents the measured cold
    // build+homepage worst case that the old 32m ceiling kept cancelling.
    expect(buildJob).toMatch(/timeout-minutes:\s*45/);
    expect(buildJob).toMatch(/run:\s*bun run build/);
    expect(buildJob).not.toMatch(/continue-on-error|\|\| true/);

    const setup = readFileSync(
      join(
        REAL_REPO_ROOT,
        ".github",
        "actions",
        "setup-bun-workspace",
        "action.yml",
      ),
      "utf8",
    );
    expect(setup).toMatch(/cache-bun-install:[\s\S]*default:\s*["']true["']/);
    expect(setup).toMatch(
      /name:\s*Cache Bun install[\s\S]*if:\s*\$\{\{\s*inputs\.cache-bun-install == ["']true["']\s*\}\}/,
    );
  });

  test("the real repo satisfies the canonical cache contract", () => {
    const { workflowCount } = runContract(REAL_REPO_ROOT);
    expect(workflowCount).toBeGreaterThan(0);
  });
});
