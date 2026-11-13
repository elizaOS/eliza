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
		"AtomicJsonPublication.qnt",
		{
			file: "test/atomic-json-filesystem.test.ts",
			tests: [
				"readers observe complete snapshots across independent async and sync writer processes",
				"same-target async writes retain invocation order while publication is pending",
				"rename failures preserve the destination and later async writes remain usable",
				"process termination before-rename retains the published snapshot and permits a fresh writer",
				"process termination after-rename retains the published snapshot and permits a fresh writer",
			],
		},
	],
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
	[
		"ProviderExecution.qnt",
		{
			file: "test/compose-state-provider-execution.test.ts",
			tests: [
				"starts sibling providers concurrently",
				"uses position only for render order and gives siblings the same pre-compose state",
				"coalesces duplicate in-flight provider work for the same message",
				"defers reference bodies only for named owner-exclusive providers and never joins a complete run",
				"does not reuse cached provider state for the same message id in another room",
				"does not coalesce concurrent provider work across rooms with the same message id",
				"throws and reports provider failures instead of caching empty context",
				"keeps a provider-originated AbortError observable as an ordinary failure",
				"keeps a provider-originated TimeoutError observable as an ordinary failure",
				"passes the active turn signal to providers and reports cancellation",
				"stops awaiting non-cooperative work and observes its detached rejection",
				"observes host cancellation through the merged owner inside a room turn",
				"keeps nested model work on the shared execution when its creator cancels",
				"keeps nested provider model tokens out of the visible reply stream",
				"keeps provider-internal model calls off the streaming path for a caller with no streaming context",
				"starts one trajectory step per provider at its first model call when provider calls run concurrently",
				"does not start provider work for an owner that was already cancelled",
				"does not cache state when the owner aborts after providers settle",
				"does not finish composition after runtime shutdown begins post-settlement",
				"lets a coalesced waiter cancel its own turn without killing the owner (#17602)",
				"counts signal-less callers so a waiter's abort cannot kill their shared work",
				"keeps the shared provider alive when the owner aborts while a waiter remains (#17602)",
				"aborts the shared provider exactly when the last interested caller aborts (#17602)",
				"does not hand a fresh caller a departed owner's abort reason while eviction lags settlement",
				"runtime stop releases a signal-less caller from non-cooperative work",
				"runtime stop also releases one-off provider work for explicit refresh",
				"runtime stop also releases one-off provider work for message without id",
			].map((title) => `composeState provider execution ${title}`),
		},
	],
	[
		"RuntimeLifecycle.qnt",
		{
			file: "test/runtime-lifecycle-model.test.ts",
			tests: [
				"does not start a plugin service when initialize() fails",
				"aborts a turn that was queued behind the room owner when stop() began",
				"does not return a stopped service from getService after stop()",
			],
		},
	],
	[
		"ServiceLifecycle.qnt",
		{
			file: "test/service-lifecycle-model.test.ts",
			tests: [
				"reports a running sibling as registered when another sibling failed",
				"stops a service once when plugin unload races runtime stop",
				"keeps a sibling that started while plugin unload was stopping its class",
				"stops the unloaded instance when runtime stop runs while unload awaits a sibling start",
				"leaves no registration status when unload runs while the only class is mid-start",
				"leaves no registration status when unload runs while the only class emits its start event",
				"leaves no registration status at any tick after the only class's start settled",
			],
		},
	],
	[
		"PluginLifecycle.qnt",
		{
			file: "test/plugin-lifecycle-model.test.ts",
			tests: [
				"a service load during unload does not leave a live instance of the unloaded plugin",
				"unload during a service start removes the connectors that start registers",
				"unload removes a connector registered by a lazily started service",
				"unload stops every owned instance when one stop rejects",
				"runtime stop during unload stops each service instance once",
				"concurrent unloads of one plugin run its teardown once",
				"a duplicate register during a failing init does not report success",
				"a register whose rollback also fails rejects with the init error",
			],
		},
	],
	[
		"SingleFlightMemo.qnt",
		{
			file: "test/read-memo-runtime.test.ts",
			tests: [
				"bounds cached room reads by elapsed time despite wall clock rollback",
			],
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
