#!/usr/bin/env node
/** Run one deterministic, full-coverage slice of the workspace typecheck. */
import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function partitionNames(names, shardCount) {
  const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b));
  return Array.from({ length: shardCount }, (_, index) =>
    sorted.filter((_, packageIndex) => packageIndex % shardCount === index),
  );
}

export function discoverWorkspaceNames(root = repoRoot) {
  const rootPackage = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  const patterns = rootPackage.workspaces ?? [];
  const manifests = new Set();

  for (const pattern of patterns.filter((item) => !item.startsWith("!"))) {
    for (const manifest of globSync(`${pattern}/package.json`, { cwd: root })) {
      manifests.add(manifest);
    }
  }
  for (const pattern of patterns.filter((item) => item.startsWith("!"))) {
    for (const manifest of globSync(`${pattern.slice(1)}/package.json`, {
      cwd: root,
    })) {
      manifests.delete(manifest);
    }
  }

  return [...manifests].map((manifest) => {
    const pkg = JSON.parse(readFileSync(resolve(root, manifest), "utf8"));
    if (!pkg.name)
      throw new Error(`${manifest}: workspace package has no name`);
    return pkg.name;
  });
}

export function selectShard(names, shardIndex, shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`invalid shard count: ${shardCount}`);
  }
  if (
    !Number.isInteger(shardIndex) ||
    shardIndex < 0 ||
    shardIndex >= shardCount
  ) {
    throw new Error(
      `invalid shard index ${shardIndex} for count ${shardCount}`,
    );
  }
  return partitionNames(names, shardCount)[shardIndex];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const shardIndex = Number.parseInt(process.argv[2] ?? "", 10);
  const shardCount = Number.parseInt(process.argv[3] ?? "", 10);
  const selected = selectShard(
    discoverWorkspaceNames(),
    shardIndex,
    shardCount,
  );
  if (selected.length === 0) {
    console.error(
      `[typecheck-shard] shard ${shardIndex}/${shardCount} is empty`,
    );
    process.exit(1);
  }
  console.log(
    `[typecheck-shard] shard ${shardIndex + 1}/${shardCount}: ${selected.length} workspace packages`,
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "packages/scripts/run-turbo.mjs"),
      "run",
      "typecheck",
      "--concurrency=8",
      ...selected.map((name) => `--filter=${name}`),
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=8192" },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
