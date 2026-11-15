/** Replay generated grammar class cases through pinned llama.cpp grammar parsers. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const core = path.resolve(import.meta.dirname, "..");
const model = path.resolve(process.argv[2] ?? "");
assert.equal(model, path.join(import.meta.dirname, "GrammarClassEscape.qnt"));
const output = testOutputPath("quint-grammar-class-escape");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
	process.execPath,
	[
		path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
		"run",
		model,
		"--main=GrammarClassEscape",
		"--backend=typescript",
		"--seed=20261113",
		"--max-samples=300",
		"--n-traces=300",
		"--max-steps=3",
		"--invariant=Loads",
		`--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
		"--verbosity=0",
	],
	{ stdio: "inherit" },
);
const cases = new Map();
for (const file of readdirSync(directory)) {
	for (const state of JSON.parse(
		readFileSync(path.join(directory, file), "utf8"),
	).states) {
		if (Number(state.phase["#bigint"]) !== 2) continue;
		const fields = Object.fromEntries(
			["member", "parser", "token"].map((key) => [
				key,
				Number(state[key]["#bigint"]),
			]),
		);
		fields.loaded = state.loaded;
		cases.set(`${fields.member}:${fields.parser}`, fields);
	}
}
assert.equal(
	cases.size,
	10,
	"All five class members must be generated for both parsers",
);
const ordered = [...cases.values()].sort(
	(a, b) => a.parser - b.parser || a.member - b.member,
);
const input = path.join(directory, "cases.json");
writeFileSync(input, JSON.stringify(ordered));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/planner-grammar-class-loader.real.test.ts";
const child = spawnSync(
	process.execPath,
	[
		path.join(root, "packages/scripts/run-with-deadline.ts"),
		"180000",
		"--",
		process.execPath,
		path.join(root, "packages/scripts/run-vitest.ts"),
		"run",
		file,
		"--cache=false",
		"--reporter=json",
		`--outputFile=${report}`,
	],
	{
		cwd: core,
		encoding: "utf8",
		env: {
			...process.env,
			// *.real.test.* files run in the post-merge lane.
			VITEST_LANE: "post-merge",
			ELIZA_GRAMMAR_CLASS_MODEL_CASES: input,
		},
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Grammar class conformance failed. See ${log}`);
const members = [
	"a plain character",
	"a literal hyphen",
	"a literal caret",
	"a closing bracket",
	"a range",
];
const parsers = ["the elizaOS/llama.cpp submodule pin", "llama-cpp-capacitor"];
// A skipped parser (no compiler or no sources) fails the check.
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	ordered.map(
		({ member, parser }) =>
			`strict planner grammar classes in pinned llama.cpp grammar parsers loads and matches the generated case for ${members[member]} in ${parsers[parser]}`,
	),
);
console.log(
	`Passed ${checks.length} model-generated grammar class cases in real llama.cpp grammar parsers. Report ${report}`,
);
