#!/usr/bin/env node
/** Proves complete CI shard execution and fixture isolation through the real Node process supervisor. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunkByBudget,
  maxFilesPerTestBatch,
  runBatches,
  runCommandWithWatchdog,
  selectTestShard,
} from "./test-cloud-run.mjs";

const root = mkdtempSync(join(tmpdir(), "test-cloud-shards-"));
const output = join(root, "executed.jsonl");
const files = ["route-a", "route-b", "route-c", "route-d"].map((name) =>
  join(root, `${name}.test.ts`),
);
try {
  for (const [index, file] of files.entries()) {
    writeFileSync(
      file,
      [
        'import { test, expect } from "bun:test";',
        'import { appendFileSync } from "node:fs";',
        `test("request fixture ${index}", () => {`,
        '  process.stderr.write("stdio registration fixture\\n");',
        "  expect(process.env.CLOUD_FIXTURE_OWNER).toBeUndefined();",
        `  process.env.CLOUD_FIXTURE_OWNER = ${JSON.stringify(file)};`,
        `  appendFileSync(${JSON.stringify(output)}, JSON.stringify({ file: ${JSON.stringify(file)}, pid: process.pid }) + "\\n");`,
        "});",
      ].join("\n"),
    );
  }
  const batches = chunkByBudget(files, maxFilesPerTestBatch("linux"), 100000);
  const env = { ...process.env };
  delete env.CLOUD_FIXTURE_OWNER;
  let diagnostics = "";
  const shardCount = Math.min(2, batches.length);
  for (let shard = 1; shard <= shardCount; shard += 1) {
    const failed = await runBatches(
      selectTestShard(batches, `${shard}/${shardCount}`),
      {
        repoRoot: root,
        stagingDir: root,
        env,
        writeOut: (text) => {
          diagnostics += text;
        },
        writeErr: (text) => {
          diagnostics += text;
        },
        spawnBatch: (batch, options) =>
          runCommandWithWatchdog(
            "bun",
            ["test", "--isolate", ...batch],
            options,
          ),
      },
    );
    assert.equal(failed, false, diagnostics);
  }
  const executions = readFileSync(output, "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.deepEqual(
    executions.map((entry) => entry.file).sort(),
    [...files].sort(),
  );
  assert.equal(
    new Set(executions.map((entry) => entry.pid)).size,
    files.length,
  );
  process.stdout.write(
    "[test-cloud-shards] complete once-only execution and process isolation passed\n",
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
