/** Require the named real Core concurrency suites for their Quint models. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const core = path.resolve(import.meta.dirname, "..");
const suites = new Map([
	[
		"Semaphore.qnt",
		{
			file: "test/semaphore.test.ts",
			tests: [
				...[
					"keeps existing no-signal callers in FIFO order",
					...[0, 1, 2].map(
						(index) =>
							`removes cancelled queue position ${index} without losing a permit`,
					),
					"does not consume a permit for a pre-aborted caller",
					"leaves release ownership with a caller cancelled after admission",
					"does not reject or release twice when cancellation follows a queued grant",
				].map((title) => `Semaphore cancellation ${title}`),
				...[1, 2].map(
					(capacity) =>
						`does not grant a cancelled waiter during an earlier abort listener at capacity ${capacity}`,
				),
			],
		},
	],
	[
		"RoomHandlerQueue.qnt",
		{
			file: "test/room-handler-queue-model.test.ts",
			tests: [
				"reuses the ambient lease for a nested withLease on the same room (WaiterServed)",
				"refuses a nested withLease that widens to another room (OrderedAcquisition)",
				"reuses a held room for a nested withLease inside withLeases (Nest)",
				"refuses a nested withLease inside withLeases that widens to another room (OrderedAcquisition)",
				"treats an ambient store whose leases are released as no ownership (withLeases continuation)",
			].map((title) => `RoomHandlerQueue model properties ${title}`),
		},
	],
]);

const model = path.resolve(root, process.argv[2] ?? "");
assert.equal(path.dirname(model), import.meta.dirname);
const suite = suites.get(path.basename(model));
assert(suite, "Expected a Core concurrency model");

const output = testOutputPath("quint-core-concurrency");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const child = spawnSync(
	process.execPath,
	[
		path.join(root, "packages/scripts/run-with-deadline.ts"),
		"120000",
		"--",
		process.execPath,
		path.join(root, "packages/scripts/run-vitest.ts"),
		"run",
		suite.file,
		"--cache=false",
		"--reporter=json",
		`--outputFile=${report}`,
	],
	{ cwd: core, encoding: "utf8" },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Core concurrency suite failed. See ${log}`);
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, suite.file),
	suite.tests,
);
console.log(
	`Passed ${checks.length} named tests for ${model}. Report ${report}`,
);
