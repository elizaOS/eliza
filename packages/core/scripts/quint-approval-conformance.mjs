/** Exercises actual approval workers, timer callbacks, plugin unload and SQLite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const core = path.resolve(import.meta.dirname, "..");
const model = path.join(core, "quint/ApprovalService.qnt");
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);
const test = "test/approval-service-model.test.ts";
const required = [
	"runs onTimeout or onSelect, never both (AtMostOneCallback)",
	"runs onSelect once for two concurrent selections (AtMostOneCallback)",
	"does not report cancelled after onSelect ran (ResultAgrees)",
	"confirms owned cancellation only after SQLite deletion and preserves a failed owner's retry",
	"exclusively owns callback-free cancellation until its durable acknowledgement",
	"restores the original deadline after cancellation deletion fails past expiry",
	"refuses a positive timeout receipt when cancellation deletion commits without its acknowledgement",
	"drains an owned cancellation acknowledgement before stop settles its caller",
	"rejects an owned cancellation failure during stop without a false cancelled receipt",
	"settles the caller when onSelect throws (CallerSettles)",
	"rejects and reports a timeout callback failure through the real runtime",
	"drains admitted task creation on plugin unload and rejects late ownership",
	"drains an already claimed callback before plugin unload completes",
	"drains a claimed timeout callback before plugin unload completes",
	"cancels an unclaimed selection and drains its admitted SQLite read",
	"drains admitted list and worker permission queries on plugin unload",
	"retains an unclaimed approval after selection read failure until unload",
	"expires a callback-free asynchronous approval through its real timer",
	"refuses to acknowledge a retry after its required callback failed",
	"retains an orphaned callback task after runtime restart and permits explicit cancellation",
	"selects a persisted callback-free task after runtime restart",
	"retains the row when deletion fails after a completed approval effect",
	"keeps synchronous approval receipt fields source-owned despite attached metadata",
];

const output = testOutputPath("quint-approval");
mkdirSync(output, { recursive: true });
const run = mkdtempSync(path.join(output, "conformance-"));
const reportFile = path.join(run, "vitest.json");
const result = spawnSync(
	process.execPath,
	[
		"../scripts/run-with-deadline.ts",
		"180000",
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
		`--outputFile=${reportFile}`,
	],
	{ cwd: core, stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "Approval implementation tests failed");

const report = JSON.parse(readFileSync(reportFile, "utf8"));
assert.equal(report.success, true);
assert.equal(report.numFailedTests, 0);
assert.equal(report.numPendingTests, 0);
assert.equal(report.numTodoTests, 0);
assert.equal(report.testResults.length, 1);
const [file] = report.testResults;
assert.equal(file.name, path.join(core, test));
for (const title of required) {
	const matches = file.assertionResults.filter(
		({ fullName }) => fullName === `ApprovalService model properties ${title}`,
	);
	assert.equal(
		matches.length,
		1,
		`Missing or duplicated conformance case ${title}`,
	);
	assert.equal(
		matches[0].status,
		"passed",
		`Conformance case did not pass: ${title}`,
	);
}
console.log(
	`Approval conformance passed all ${required.length} required cases. Report ${reportFile}`,
);
