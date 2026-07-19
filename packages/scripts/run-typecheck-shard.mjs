#!/usr/bin/env node
/** Run one deterministic, full-coverage slice of Turbo's workspace graph. */
import { existsSync } from "node:fs";
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

export function parseTurboPackageNames(json) {
  const parsed = JSON.parse(json);
  const items = parsed?.packages?.items;
  if (!Array.isArray(items)) {
    throw new Error("turbo ls JSON did not contain packages.items");
  }
  const names = items.map((item) => item?.name).filter(Boolean);
  if (names.length !== items.length) {
    throw new Error("turbo ls returned a workspace package without a name");
  }
  return names;
}

export function discoverWorkspaceNames(root = repoRoot) {
  const turbo = resolve(root, "node_modules/.bin/turbo");
  if (!existsSync(turbo)) throw new Error(`Turbo binary not found at ${turbo}`);
  const result = spawnSync(turbo, ["ls", "--output=json"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`turbo ls failed (${result.status}): ${result.stderr}`);
  }
  return parseTurboPackageNames(result.stdout);
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
    `[typecheck-shard] shard ${shardIndex + 1}/${shardCount}: ${selected.length} Turbo workspace packages`,
  );
  const result = spawnSync(
    process.execPath,
    [
      resolve(repoRoot, "packages/scripts/run-turbo.mjs"),
      "run",
      "typecheck",
      "--concurrency=8",
      // Include each selected package's dependency closure. Several workspace
      // packages resolve sibling types from dist/, so a bare package filter can
      // expose false missing-module errors that the full graph materializes.
      ...selected.map((name) => `--filter=${name}...`),
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
