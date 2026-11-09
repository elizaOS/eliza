/** Runs the real PostDeliveryTasks protocol tests for the Quint gate. */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const packageRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const repositoryRoot = path.resolve(packageRoot, "../..");
const model = path.join(packageRoot, "quint/PostDeliveryTasks.qnt");
if (
	process.argv.length > 3 ||
	(process.argv[2] && path.resolve(repositoryRoot, process.argv[2]) !== model)
) {
	throw new Error("Post-delivery conformance requires its own Quint model");
}

const requiredTitles = [
	"requires an exact live room lease and preserves both indexes on refusal",
	"holds the real room owner until delivery and room-state work settle",
	"settles failed delivery as false before removing its boundary",
	"preserves a captured failed settlement after quarantine removes the boundary",
	"repeats drain batches and separates room state from other rooms and diagnostics",
	"rechecks runtime work registered while its first batch is settling",
	"returns initially empty drains before consulting their aborted signal",
	"refuses queued callback invocation and future admissions after an aborted drain",
	"retains a non-cooperative running task after cancellation until it actually settles",
	"lets an existing un-signalled drain finish after external quarantine",
];
const requiredNames = new Set(
	requiredTitles.map(
		(title) => `PostDeliveryTasks source conformance ${title}`,
	),
);
const outputRoot = testOutputPath("quint-post-delivery");
mkdirSync(outputRoot, { recursive: true });
const reportPath = path.join(
	mkdtempSync(path.join(outputRoot, "conformance-")),
	"vitest.json",
);

const child = spawn(
	process.execPath,
	[
		// The existing supervisor forwards cancellation through the full worker tree.
		path.join(repositoryRoot, "packages/scripts/run-with-deadline.ts"),
		"600000",
		"--",
		process.execPath,
		path.join(repositoryRoot, "packages/scripts/run-vitest.ts"),
		"run",
		"test/post-delivery-task-conformance.test.ts",
		"--reporter=json",
		`--outputFile=${reportPath}`,
	],
	{ cwd: packageRoot, env: process.env, stdio: "inherit" },
);
let interrupted;
const interrupt = (signal) => {
	interrupted ??= signal;
	child.kill(signal);
};
const onInterrupt = () => interrupt("SIGINT");
const onTerminate = () => interrupt("SIGTERM");
process.once("SIGINT", onInterrupt);
process.once("SIGTERM", onTerminate);
let result;
try {
	result = await new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
} finally {
	process.removeListener("SIGINT", onInterrupt);
	process.removeListener("SIGTERM", onTerminate);
}
if (interrupted || result.signal) {
	process.kill(process.pid, interrupted ?? result.signal);
} else if (result.code !== 0) {
	throw new Error(
		`Post-delivery conformance runner exited with ${result.code}`,
	);
} else {
	const report = JSON.parse(readFileSync(reportPath, "utf8"));
	const assertions = Array.isArray(report.testResults)
		? report.testResults.flatMap((file) => file.assertionResults ?? [])
		: [];
	const names = new Set(assertions.map((assertion) => assertion.fullName));
	if (
		report.success !== true ||
		report.numTotalTests !== requiredNames.size ||
		report.numPassedTests !== requiredNames.size ||
		report.numFailedTests !== 0 ||
		assertions.length !== requiredNames.size ||
		names.size !== requiredNames.size ||
		assertions.some((assertion) => assertion.status !== "passed") ||
		[...requiredNames].some((name) => !names.has(name))
	) {
		throw new Error(
			`Post-delivery conformance did not pass all required tests. Report ${reportPath}`,
		);
	}
	console.log(
		`PostDeliveryTasks conformance passed ${requiredNames.size} required tests`,
	);
	console.log(`JSON report ${reportPath}`);
}
