// Pins the GitHub-native Turbo cache contract (#12341) against synthetic repo
// trees: a clean adopter passes, an adopter that re-adds the Vercel SaaS
// remote-cache env fails, and an unpinned/floating actions/cache ref fails.
// Also runs the shipped contract against the real repo so the guard stays true
// as the migration proceeds. Deterministic — no workflow is executed.
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

const SHIM_YAML = `name: "GitHub-native Turbo cache"
description: "test shim"
runs:
  using: "composite"
  steps:
    - run: node packages/scripts/turbo-cache-key.mjs --github-output
      shell: bash
    - uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9
      with:
        path: .turbo
`;

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
`;

const CLEAN_ADOPTER = `name: Clean adopter
on: [workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-24.04
    steps:
      - uses: ./.github/actions/turbo-cache-github
      - run: bun run build
`;

const SAAS_READDER = `name: Regressing adopter
on: [workflow_dispatch]
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      TURBO_TOKEN: \${{ secrets.TURBO_TOKEN }}
      TURBO_TEAM: \${{ vars.TURBO_TEAM }}
      TURBO_CACHE: remote:rw
    steps:
      - uses: ./.github/actions/turbo-cache-github
      - run: bun run build
`;

function buildRepo({
  shim = SHIM_YAML,
  workspaceSetup = WORKSPACE_SETUP_YAML,
  workflows = {},
}) {
  const root = mkdtempSync(join(tmpdir(), "turbo-cache-contract-"));
  mkdirSync(join(root, ".github", "actions", "turbo-cache-github"), {
    recursive: true,
  });
  mkdirSync(join(root, ".github", "actions", "setup-bun-workspace"), {
    recursive: true,
  });
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "actions", "turbo-cache-github", "action.yml"),
    shim,
  );
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
  test("passes a clean adopter that uses the shim without SaaS env", () => {
    const root = buildRepo({ workflows: { "clean.yml": CLEAN_ADOPTER } });
    try {
      const { adopters } = runContract(root);
      expect(adopters).toEqual([".github/workflows/clean.yml"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when an adopting workflow re-adds the SaaS remote cache env", () => {
    const root = buildRepo({ workflows: { "regress.yml": SAAS_READDER } });
    try {
      expect(() => runContract(root)).toThrow(
        /still wires the SaaS remote cache/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when actions/cache is not pinned to a full commit SHA", () => {
    const floatingShim = SHIM_YAML.replace(
      "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
      "actions/cache@v4",
    );
    const root = buildRepo({
      shim: floatingShim,
      workflows: { "clean.yml": CLEAN_ADOPTER },
    });
    try {
      expect(() => runContract(root)).toThrow(
        /pinned to a full 40-char commit SHA/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when the shim itself wires the SaaS remote cache", () => {
    const dirtyShim = SHIM_YAML.replace(
      "  steps:",
      "  env:\n    TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}\n  steps:",
    );
    const root = buildRepo({ shim: dirtyShim });
    try {
      expect(() => runContract(root)).toThrow(
        /shim must not wire the SaaS remote cache/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails when workspace setup nests the cache shim", () => {
    const nestedSetup = WORKSPACE_SETUP_YAML.replace(
      /    - name: Restore and save Turbo cache[\s\S]*$/,
      "    - uses: ./.github/actions/turbo-cache-github\n",
    );
    const root = buildRepo({ workspaceSetup: nestedSetup });
    try {
      expect(() => runContract(root)).toThrow(
        /must not nest the Turbo cache shim/,
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

  test("the fork typecheck keeps full coverage with a bounded cold-cache allowance", () => {
    const workflow = readFileSync(
      join(REAL_REPO_ROOT, ".github", "workflows", "quality-fork.yml"),
      "utf8",
    );
    const typecheckJob = workflow.match(
      /^  typecheck:\s*$([\s\S]*?)(?=^  build:\s*$)/m,
    )?.[0];
    expect(typecheckJob).toBeDefined();
    expect(typecheckJob).toMatch(/timeout-minutes:\s*25/);
    expect(typecheckJob).toMatch(/run:\s*bun run typecheck/);
    expect(typecheckJob).not.toMatch(/continue-on-error|\|\| true/);
  });

  test("the long cold lanes avoid stale Bun fallback restores", () => {
    const workflow = readFileSync(
      join(REAL_REPO_ROOT, ".github", "workflows", "quality-fork.yml"),
      "utf8",
    );
    const typecheckJob = workflow.match(
      /^  typecheck:\s*$([\s\S]*?)(?=^  build:\s*$)/m,
    )?.[0];
    const buildJob = workflow.match(
      /^  build:\s*$([\s\S]*?)(?=^  elizaos-cli-global-smoke:\s*$)/m,
    )?.[0];
    expect(typecheckJob).toMatch(/cache-bun-install:\s*["']false["']/);
    expect(buildJob).toMatch(/cache-bun-install:\s*["']false["']/);
    expect(buildJob).toMatch(/timeout-minutes:\s*30/);
    expect(buildJob).toMatch(/run:\s*bun run build/);
    expect(buildJob).toMatch(/run:\s*bun run test:e2e/);
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

  test("the real repo satisfies the contract (shim pinned, no mixing)", () => {
    const { adopters } = runContract(REAL_REPO_ROOT);
    expect(Array.isArray(adopters)).toBe(true);
  });
});
