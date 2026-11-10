/** Checks scheduler query retirement through real runtime and PGlite storage. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const core = path.resolve(import.meta.dirname, "..");
const model = path.join(core, "quint/TaskSchedulerQueryDrain.qnt");
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);
const test = "test/task-scheduler-model.test.ts";
const required = [
	"service stop drains a shared query before its runtime storage closes",
	"scheduler stop drains its detached query while a replacement registration runs",
	"a host runDueTasks during a daemon tick does not run a one-shot twice",
	"a stale snapshot does not rerun a one-shot that already ran",
	"a failed one-shot re-read keeps the task for a later run",
	"executeTaskById does not overlap a blocking repeat task's tick run",
	"a scheduler restart does not dispatch a second runTick to a busy service",
];
const output = testOutputPath("quint-scheduler-query");
mkdirSync(output, { recursive: true });
const run = mkdtempSync(path.join(output, "conformance-"));
const report = path.join(run, "vitest.json");
const result = spawnSync(
	process.execPath,
	[
		"../scripts/run-with-deadline.ts",
		"300000",
		"--",
		process.execPath,
		"../scripts/run-vitest.ts",
		"run",
		test,
		"--maxWorkers=1",
		"--retry=0",
		"--no-cache",
		`--fsModuleCachePath=${path.join(run, "module-cache")}`,
		"--reporter=json",
		`--outputFile=${report}`,
	],
	{ cwd: core, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "Task scheduler conformance failed");
const evidence = JSON.parse(readFileSync(report, "utf8"));
assert.equal(evidence.success, true);
assert.equal(evidence.numFailedTests, 0);
assert.equal(evidence.numPendingTests, 0);
assert.equal(evidence.numTodoTests, 0);
assert.equal(evidence.testResults.length, 1);
const [file] = evidence.testResults;
assert.equal(path.resolve(file.name), path.join(core, test));
for (const name of required) {
	const matches = file.assertionResults.filter(
		({ fullName }) => fullName === name,
	);
	assert.equal(
		matches.length,
		1,
		`Missing or duplicate scheduler case ${name}`,
	);
	assert.equal(
		matches[0].status,
		"passed",
		`Scheduler case did not pass: ${name}`,
	);
}
assert(file.assertionResults.every(({ status }) => status === "passed"));
console.log(
	`Scheduler conformance passed all ${required.length} required cases. Report ${report}`,
);
