/**
 * test-task-pool.mjs
 *
 * Concurrency primitives for the cross-package test runner
 * (`run-all-tests.mjs`). That script executes its main loop on import, so the
 * parallelizable logic lives here where it can be unit-tested in isolation.
 *
 * The runner has historically been strictly serial: one package's test script
 * had to exit before the next could start. The only cross-package parallelism
 * came from turbo `--concurrency` inside specific aggregate scripts and from CI
 * sharding. This module lets the runner opt into a bounded worker pool over the
 * package set that is proven safe to run concurrently.
 *
 * Safety model (mirrors the existing, proven `test:plugins` policy in the root
 * package.json, which already runs ~140 plugin packages at `--concurrency 3`):
 *
 *   - Only the plain `test` script in the secret-free PR lane is parallel-safe.
 *     There, vitest forks bind ephemeral ports and `*.real`/`*.real.e2e` files
 *     are excluded (VITEST_EXCLUDE_REAL), so there is no shared-Postgres or
 *     fixed-port contention between packages.
 *   - The EXTRA_SCRIPT_NAMES lanes (test:integration / test:e2e /
 *     test:playwright / test:ui / test:live) bind fixed ports and/or touch the
 *     shared `eliza_test` database, so they stay serialized.
 *   - A small denylist of packages must stay serial even for their `test`
 *     script — the same two the root `test:plugins` already pulls out of the
 *     concurrent sweep, plus `plugin-sql` (it drives the shared Postgres /
 *     PGlite database with `fileParallelism: false`).
 *   - Any lane other than `pr` (i.e. the post-merge real-API lane) runs fully
 *     serial: real providers + the shared database make concurrency unsafe.
 *
 * It also owns the deterministic `TEST_SHARD=N/M` membership logic so CI
 * matrices can split the package set across runner boxes (an orthogonal,
 * cross-machine form of the same parallelism).
 */

import crypto from "node:crypto";
import { resolveTestSerialPackages } from "./script-metadata.mjs";

/**
 * Packages whose `test` script must not run concurrently with others, even in
 * the PR lane. Membership is declared per-package via `elizaos.scripts.testSerial`
 * (a shared DB harness or fixed-port contention makes concurrency unsafe) and
 * resolved here through the discovery seam — no plugin names live in this file.
 */
export const SERIALIZE_PACKAGES = resolveTestSerialPackages();

/**
 * Whether a discovered test task may run concurrently with other tasks.
 *
 * @param {{ scriptName: string, lane: string, packageName?: string }} task
 * @returns {boolean}
 */
export function isParallelSafeTask({ scriptName, lane, packageName }) {
  if (lane !== "pr") {
    return false;
  }
  if (scriptName !== "test") {
    return false;
  }
  if (packageName && SERIALIZE_PACKAGES.has(packageName)) {
    return false;
  }
  return true;
}

/**
 * Split tasks into the concurrent bucket and the serialized bucket, preserving
 * the original relative order within each bucket.
 *
 * @template {{ scriptName: string, packageName?: string }} T
 * @param {T[]} tasks
 * @param {string} lane
 * @returns {{ parallel: T[], serial: T[] }}
 */
export function partitionTasks(tasks, lane) {
  const parallel = [];
  const serial = [];
  for (const task of tasks) {
    if (isParallelSafeTask({ ...task, lane })) {
      parallel.push(task);
    } else {
      serial.push(task);
    }
  }
  return { parallel, serial };
}

/**
 * Run `items` through `worker` with at most `concurrency` invocations in flight
 * at once. Resolves to a results array in the SAME ORDER as `items` so callers
 * can pair each result with its input. Never rejects: a worker that throws
 * yields `{ ok: false, error }` in that slot, success yields `{ ok: true,
 * value }`. This lets the caller run every task to completion and report all
 * failures at the end rather than aborting on the first one.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {number} concurrency
 * @returns {Promise<Array<{ ok: true, value: R } | { ok: false, error: unknown }>>}
 */
export async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  if (items.length === 0) {
    return results;
  }
  const workers = Math.max(
    1,
    Math.min(Math.trunc(concurrency) || 1, items.length),
  );
  let next = 0;
  async function drain() {
    while (true) {
      const index = next++;
      if (index >= items.length) {
        return;
      }
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => drain()));
  return results;
}

/**
 * Normalise a requested concurrency value (CLI flag or env var) into a positive
 * integer, defaulting to 1 (fully serial — the historical behaviour).
 *
 * @param {string | number | undefined | null} value
 * @returns {number}
 */
export function normalizeConcurrency(value) {
  if (value === undefined || value === null || value === "") {
    return 1;
  }
  const parsed =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 1;
  }
  return Math.trunc(parsed);
}

/**
 * Parse a `TEST_SHARD` spec ("N/M", 1-indexed) into `{ index, total }`, or
 * `null` when absent or malformed. Pure (no warnings) so callers decide how to
 * surface an invalid spec.
 *
 * @param {string | undefined | null} spec
 * @returns {{ index: number, total: number } | null}
 */
export function parseShardSpec(spec) {
  if (!spec) {
    return null;
  }
  const parts = String(spec).split("/");
  if (parts.length !== 2) {
    return null;
  }
  const index = Number.parseInt(parts[0], 10);
  const total = Number.parseInt(parts[1], 10);
  if (
    !Number.isInteger(index) ||
    !Number.isInteger(total) ||
    total <= 0 ||
    index < 1 ||
    index > total
  ) {
    return null;
  }
  return { index, total };
}

/**
 * Stable shard membership: SHA-1 of the task key (the task's relative package
 * dir) → bucket → assign to shard N (1-indexed) of M. Hashing the relative dir
 * rather than the full label keeps a package's `test` and `test:e2e` tasks in
 * the same shard, amortising Postgres + mock startup across the package's full
 * task set. Returns true when there is no shard config (run everything).
 *
 * @param {string} taskKey
 * @param {{ index: number, total: number } | null} shardCfg
 * @returns {boolean}
 */
export function taskBelongsToShard(taskKey, shardCfg) {
  if (!shardCfg) {
    return true;
  }
  const digest = crypto.createHash("sha1").update(taskKey).digest();
  const bucket = digest.readUInt32BE(0) % shardCfg.total;
  return bucket === shardCfg.index - 1;
}
