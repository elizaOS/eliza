import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const { runContract } = await import(
  new URL("../quality-fork-typecheck-contract.mjs", import.meta.url).href
);
const { discoverWorkspaceNames, partitionNames, selectShard } = await import(
  new URL("../run-typecheck-shard.mjs", import.meta.url).href
);
const REAL_REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const WORKFLOW = `name: Quality (Fork)
jobs:
  typecheck-shards:
    name: Type Check (\${{ matrix.shard }}/\${{ strategy.job-total }})
    strategy:
      fail-fast: false
      matrix:
        shard: [0, 1, 2, 3]
    steps:
      - name: Run typecheck shard
        run: node packages/scripts/run-typecheck-shard.mjs \${{ matrix.shard }} \${{ strategy.job-total }}
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

function buildRepo(workflow = WORKFLOW) {
  const root = mkdtempSync(join(tmpdir(), "quality-fork-typecheck-contract-"));
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(
    join(root, ".github", "workflows", "quality-fork.yml"),
    workflow,
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["packages/*"] }),
  );
  return root;
}

describe("quality-fork-typecheck-contract", () => {
  test("accepts four deterministic, fail-closed shards", () => {
    const root = buildRepo();
    try {
      expect(runContract(root)).toEqual({ workspaces: 1, shards: 4 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("partitioning is deterministic, balanced, and covers each name once", () => {
    const names = ["z", "a", "d", "b", "c", "e", "f"];
    const partitions = partitionNames(names, 4);
    expect(partitions.flat().sort()).toEqual([...names].sort());
    expect(partitions.map((part) => part.length)).toEqual([2, 2, 2, 1]);
    expect(partitionNames([...names].reverse(), 4)).toEqual(partitions);
  });

  test("workspace discovery expands nested globs and honors exclusions", () => {
    const root = mkdtempSync(join(tmpdir(), "typecheck-workspaces-"));
    try {
      for (const [path, name] of [
        ["packages/a", "a"],
        ["packages/nested/b", "b"],
        ["packages/excluded", "x"],
      ]) {
        mkdirSync(join(root, path), { recursive: true });
        writeFileSync(
          join(root, path, "package.json"),
          JSON.stringify({ name }),
        );
      }
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          workspaces: ["packages/*", "packages/*/*", "!packages/excluded"],
        }),
      );
      expect(discoverWorkspaceNames(root).sort()).toEqual(["a", "b"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an invalid shard boundary", () => {
    expect(() => selectShard(["a"], 4, 4)).toThrow(/invalid shard index/);
  });

  test("rejects shard count reduction", () => {
    const root = buildRepo(WORKFLOW.replace("[0, 1, 2, 3]", "[0, 1]"));
    try {
      expect(() => runContract(root)).toThrow(
        /four deterministic cold-cache shards/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a summary that does not fail closed", () => {
    const root = buildRepo(
      WORKFLOW.replace('test "$SHARD_RESULT" = success', "echo advisory"),
    );
    try {
      expect(() => runContract(root)).toThrow(/summary must fail closed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the checked-in workflow covers every declared workspace", () => {
    const result = runContract(REAL_REPO_ROOT);
    expect(result.shards).toBe(4);
    expect(result.workspaces).toBeGreaterThan(0);
  });
});
