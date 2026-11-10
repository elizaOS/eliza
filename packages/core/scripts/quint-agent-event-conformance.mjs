/** Exercises the event service and its diagnostic feedback through AgentRuntime. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const core = path.resolve(import.meta.dirname, "..");
const model = path.join(core, "quint/AgentEventService.qnt");
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);
const test = "test/agent-event-bridge.test.ts";
const required = [
	"keeps delivering to peers when an event callback detaches itself",
	"delivers the original event before its listener failure diagnostics",
	"keeps newer registrations when old event and heartbeat handles detach",
	"clears per-run sequence state after RUN_ENDED (no map leak)",
	"drops one-shot message sequence state but keeps the current run's",
];

const output = testOutputPath("quint-agent-event");
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
assert.equal(result.status, 0, "Agent event implementation tests failed");

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
		({ fullName }) => fullName === `agent-event-bridge ${title}`,
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
	`Agent event conformance passed all ${required.length} required cases. Report ${reportFile}`,
);
