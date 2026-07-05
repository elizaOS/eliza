import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatFailureTable,
  isRealCompletedFailure,
  isSupersededCheckRun,
  parseArgs,
  readRunsFromFile,
  selectRealFailures,
} from "./ci-real-failures.mjs";

const run = (overrides) => ({
  name: "check",
  status: "completed",
  conclusion: "success",
  html_url: "https://example.test/run",
  workflow_name: "workflow",
  ...overrides,
});

assert.equal(isRealCompletedFailure(run({ conclusion: "failure" })), true);
assert.equal(isRealCompletedFailure(run({ conclusion: "success" })), false);
assert.equal(isRealCompletedFailure(run({ conclusion: "skipped" })), false);
assert.equal(isRealCompletedFailure(run({ conclusion: "cancelled" })), false);
assert.equal(
  isRealCompletedFailure(run({ status: "queued", conclusion: null })),
  false,
);
assert.equal(
  isRealCompletedFailure(run({ conclusion: "failure", superseded: true })),
  false,
);
assert.equal(isSupersededCheckRun(run({ conclusion: "cancelled" })), true);
assert.equal(isSupersededCheckRun(run({ conclusion: "failure" })), false);

const selected = selectRealFailures([
  run({ name: "lint", conclusion: "failure" }),
  run({ name: "old lint", conclusion: "cancelled" }),
  run({ name: "build", conclusion: "success" }),
  run({ name: "superseded failure", conclusion: "failure", superseded: true }),
]);
assert.deepEqual(
  selected.map((entry) => entry.name),
  ["lint"],
);
assert.match(formatFailureTable(selected), /lint \[workflow\]/);
assert.match(formatFailureTable([]), /No real completed check failures/);

assert.deepEqual(parseArgs(["--repo", "elizaOS/eliza", "--pr", "14051"]), {
  json: false,
  input: null,
  repo: "elizaOS/eliza",
  pr: "14051",
  sha: null,
});
assert.throws(
  () => parseArgs(["--repo", "elizaOS/eliza"]),
  /one of --pr or --sha/,
);
assert.throws(
  () => parseArgs(["--repo", "elizaOS/eliza", "--pr", "1", "--sha", "abc"]),
  /mutually exclusive/,
);

const dir = mkdtempSync(join(tmpdir(), "ci-real-failures-"));
try {
  const input = join(dir, "runs.json");
  writeFileSync(
    input,
    JSON.stringify({ check_runs: [run({ conclusion: "failure" })] }),
  );
  assert.equal(readRunsFromFile(input).length, 1);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("ci-real-failures self-test passed");
