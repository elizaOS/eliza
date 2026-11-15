/** Bind the finite state projection to the existing production regression suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const packageRoot = path.join(root, "packages/core");
const model = path.relative(root, path.resolve(root, process.argv[2] ?? ""));
const testFile = "packages/core/test/pii-scrub.lazy-drain.pglite.test.ts";
const requiredTests = [
	"retries a failed lazy drain start and retires pending requests on stop",
	"settles a scrub item after first marker write refusal",
	"settles a scrub item after permanent marker write refusal",
	"settles a scrub item after committed observer rejection",
];
assert(
	[
		"packages/core/quint/LazyPiiDrain.qnt",
		"packages/core/quint/PiiScrubSettlement.qnt",
	].some((file) => path.normalize(file) === model),
	`Unexpected PII scrub model ${model}`,
);
const output = testOutputPath("quint-lazy-pii-drain");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const child = spawnSync(
	process.execPath,
	[
		path.join(root, "packages/scripts/run-with-deadline.ts"),
		"180000",
		"--",
		process.execPath,
		path.join(root, "packages/scripts/run-vitest.ts"),
		"run",
		"test/pii-scrub.lazy-drain.pglite.test.ts",
		"--cache=false",
		"--maxWorkers=1",
		"--reporter=json",
		`--outputFile=${report}`,
	],
	{
		cwd: packageRoot,
		env: process.env,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
	child.signal,
	null,
	`Conformance terminated by ${child.signal}. See ${log}`,
);
assert.equal(child.status, 0, `Conformance failed. See ${log}`);
const tests = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(root, testFile),
	requiredTests,
);
const inputs = Object.fromEntries(
	[model, model.replace(/\.qnt$/, ".cases.json"), testFile].map((file) => [
		file,
		createHash("sha256")
			.update(readFileSync(path.join(root, file)))
			.digest("hex"),
	]),
);
writeFileSync(
	path.join(directory, "evidence.json"),
	`${JSON.stringify({ model, inputs, tests, report }, null, 2)}\n`,
);
console.log(
	`Conformance passed ${tests.length} required cases. Evidence ${directory}`,
);
