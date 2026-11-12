/** Runs the real PairingService and SQL protocol tests for the Quint gate. */
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
const models = ["PairingIdentity.qnt", "PairingAdmission.qnt"].map((name) =>
	path.join(packageRoot, "quint", name),
);
if (
	process.argv.length > 3 ||
	(process.argv[2] &&
		!models.includes(path.resolve(repositoryRoot, process.argv[2])))
) {
	throw new Error("Pairing conformance requires its own Quint model");
}

const requiredTitles = [
	"keeps reply claims separate for distinct channel and sender tuples",
	"persists distinct request tuples created in the same millisecond",
	"keeps same-millisecond request identities separate across agents",
	"persists both allowlist tuples when their delimited strings coincide",
	"returns the persisted row identity when a duplicate grant is retained",
	"approval returns the existing grant rather than an unpersisted replacement",
	"refuses a conflicting grant identity instead of reporting another scope as stored",
	"retains the approval code after a failed grant and succeeds on retry",
	"retains a granted request until failed consumption can retry",
	"returns the row retained by a competing grant insertion",
	"expires requests after the strict TTL boundary",
	"rearms replies at TTL and explicitly after cache eviction",
	"serializes concurrent admission at the cap without evicting a pending sender",
	"keeps the admission queue usable after a real persistence failure",
];
const requiredNames = new Set(
	requiredTitles.map((title) => `pairing state identity ${title}`),
);
const outputRoot = testOutputPath("quint-pairing");
mkdirSync(outputRoot, { recursive: true });
const reportPath = path.join(
	mkdtempSync(path.join(outputRoot, "conformance-")),
	"vitest.json",
);

const environment = { ...process.env };
// This suite exercises the embedded SQL adapter on a fresh private database.
delete environment.POSTGRES_URL;
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
		"__tests__/pairing-identity.test.ts",
		"--maxWorkers=1",
		"--retry=0",
		"--reporter=json",
		`--outputFile=${reportPath}`,
	],
	{
		cwd: path.join(repositoryRoot, "plugins/plugin-sql/src"),
		env: environment,
		stdio: "inherit",
	},
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
	throw new Error(`Pairing conformance runner exited with ${result.code}`);
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
			`Pairing conformance did not pass all required tests. Report ${reportPath}`,
		);
	}
	console.log(
		`Pairing conformance passed ${requiredNames.size} required tests`,
	);
	console.log(`JSON report ${reportPath}`);
}
