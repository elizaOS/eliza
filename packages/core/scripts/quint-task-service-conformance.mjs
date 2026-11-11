/** Runs the maintained PGlite task and scheduler counterexamples. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const core = path.resolve(import.meta.dirname, "..");
const models = ["TaskService", "TaskRetirement", "TaskSchedulerQueryDrain"].map(
	(name) => path.join(core, "quint", `${name}.qnt`),
);
if (process.argv[2]) assert(models.includes(path.resolve(process.argv[2])));
const test = "test/task-scheduler-model.test.ts";
const required = [
	"runtime close drains its detached adapter query outside the dirty snapshot",
	"service stop drains a shared query before its runtime storage closes",
	"scheduler stop drains its detached query while a replacement registration runs",
	"stop drains daemon preflight before runtime storage closes",
	"stop drains an admitted by-id read and refuses its late worker",
	"stop drains every overlapping nonblocking owner and blocks an exclusive replacement",
	"retirement refuses immediate resume before it changes stored pause state",
	"a host runDueTasks during a daemon tick does not run a one-shot twice",
	"a stale snapshot does not rerun a one-shot that already ran",
	"a failed one-shot re-read keeps the task for a later run",
	"executeTaskById does not overlap a blocking repeat task's tick run",
	"a scheduler restart does not dispatch a second runTick to a busy service",
	"rechecks a peer registration after another agent awaits inside a shared batch",
];
const output = testOutputPath("quint-task-retirement");
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
assert.equal(result.status, 0, "Task implementation conformance failed");
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, test),
	required,
);
console.log(
	`Task conformance passed all ${checks.length} cases. Report ${report}`,
);
