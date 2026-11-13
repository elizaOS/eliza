/** Run the real source-sweep and fence-parser cases linked by these models. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(process.argv[2] ?? "");
const memory =
	model === path.join(import.meta.dirname, "MemorySourceSweep.qnt");
assert.ok(
	memory || model === path.join(import.meta.dirname, "ResponseFieldFences.qnt"),
);
const file = memory
	? "packages/agent/test/source-segment-media-retention.test.ts"
	: "packages/core/test/response-field-transcript-fences.test.ts";
const names = memory
	? [
			"keeps media named only in document source text and wipes an orphan source segment",
		]
	: [
			"keeps fields that follow an inline code span",
			"still sees a hallmark that comes after an inline code span",
			"does not let a shorter inner fence close a longer one",
			"does not close a fence on a marker line that has an info string",
			"still closes a fence that the field line itself opened",
			"keeps a tilde fence quoted and the fields after it",
			"does not let a different marker close the active fence",
			"does not treat a fenced quotation inside prose as the envelope",
		].map((name) => `response field transcript fences ${name}`);
const output = testOutputPath("quint-source-integrity");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(
	path.join(output, memory ? "memory-" : "fences-"),
);
const report = path.join(directory, "vitest.json");
const result = spawnSync(
	process.execPath,
	[
		path.join(root, "packages/scripts/run-with-deadline.ts"),
		"240000",
		"--",
		process.execPath,
		path.join(root, "packages/scripts/run-vitest.ts"),
		"run",
		"--config",
		memory
			? "packages/agent/vitest.config.ts"
			: "packages/core/vitest.config.ts",
		file,
		"--reporter=json",
		`--outputFile=${report}`,
	],
	{ cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
writeFileSync(
	path.join(directory, "vitest.log"),
	`${result.stdout ?? ""}\n${result.stderr ?? ""}`,
);
if (result.error) throw result.error;
assert.equal(result.signal, null, `Conformance terminated; see ${directory}`);
assert.equal(result.status, 0, `Conformance failed; see ${directory}`);
const tests = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(root, file),
	names,
);
console.log(
	`Passed ${tests.length} source-integrity cases. Evidence ${directory}`,
);
