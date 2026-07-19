import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract } = await import(
  new URL("../quality-fork-typecheck-contract.mjs", import.meta.url).href
);
const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const WORKFLOW = `name: Quality (Fork)
jobs:
  typecheck-shards:
    name: Type Check (\${{ matrix.scope }})
    strategy:
      fail-fast: false
      matrix:
        include:
          - scope: packages
            filter: ./packages/**
          - scope: plugins
            filter: ./plugins/**
    steps:
      - name: Run typecheck shard
        env:
          TYPECHECK_FILTER: \${{ matrix.filter }}
        run: NODE_OPTIONS='--max-old-space-size=8192' node packages/scripts/run-turbo.mjs run typecheck --concurrency=8 --filter="$TYPECHECK_FILTER"
  typecheck:
    name: Type Check
    if: always()
    needs: typecheck-shards
    steps:
      - name: Require every typecheck shard
        env:
          SHARD_RESULT: \${{ needs.typecheck-shards.result }}
        run: test "$SHARD_RESULT" = success
`;

function buildRepo({
  workflow = WORKFLOW,
  workspaces = ["packages/*", "plugins/*"],
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "quality-fork-typecheck-contract-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "workflows", "quality-fork.yml"),
    workflow,
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces }));
  return root;
}

describe("quality-fork-typecheck-contract", () => {
  test("accepts two fail-closed shards that cover every workspace root", () => {
    const root = buildRepo();
    try {
      expect(runContract(root)).toEqual({ workspaces: 2, filters: 2 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a workspace outside the package and plugin shards", () => {
    const root = buildRepo({ workspaces: ["packages/*", "apps/*"] });
    try {
      expect(() => runContract(root)).toThrow(/do not cover workspace glob/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects removal of either full-coverage shard", () => {
    const root = buildRepo({
      workflow: WORKFLOW.replace(
        "filter: ./plugins/**",
        "filter: ./packages/examples/**",
      ),
    });
    try {
      expect(() => runContract(root)).toThrow(
        /missing full-coverage shard filter/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a summary that does not fail closed", () => {
    const root = buildRepo({
      workflow: WORKFLOW.replace(
        'test "$SHARD_RESULT" = success',
        "echo advisory",
      ),
    });
    try {
      expect(() => runContract(root)).toThrow(/summary must fail closed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the checked-in workflow covers every declared workspace", () => {
    const result = runContract(REAL_REPO_ROOT);
    expect(result.filters).toBe(2);
    expect(result.workspaces).toBeGreaterThan(0);
  });
});
