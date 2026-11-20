/** Replay generated secret-reference sequences through a real runtime. */
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
assert.equal(
	model,
	path.join(import.meta.dirname, "SecretReferenceExposure.qnt"),
);
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
	readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-secret-reference-exposure");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const traces = path.join(directory, "traces");
mkdirSync(traces);
execFileSync(
	process.execPath,
	[
		path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
		"run",
		model,
		`--main=${modelCase.main}`,
		`--init=${modelCase.init}`,
		`--step=${modelCase.step}`,
		"--backend=typescript",
		"--seed=20261116",
		`--max-samples=${modelCase.samples}`,
		`--n-traces=${modelCase.samples}`,
		`--max-steps=${modelCase.maxSteps}`,
		"--invariants",
		...modelCase.invariants,
		`--out-itf=${path.join(traces, "trace-{seq}.itf.json")}`,
		"--verbosity=0",
	],
	{ stdio: "inherit" },
);
const number = (value) => Number(value["#bigint"]);
const set = (value) => value["#set"].map(number).sort();
const sequences = new Map();
const outcomes = new Set();
for (const file of readdirSync(traces)) {
	const states = JSON.parse(
		readFileSync(path.join(traces, file), "utf8"),
	).states;
	const steps = [];
	for (const [index, state] of states.slice(1).entries()) {
		const previous = states[index];
		const before = set(previous.exposed);
		const shown = set(state.exposed).filter((value) => !before.includes(value));
		if (shown.length > 0) steps.push({ kind: "prompt", values: shown });
		// plan only sets the pending call; execute settles it.
		if (number(previous.call) !== -1 && number(state.call) === -1) {
			const step = {
				kind: "execute",
				ref: number(previous.call),
				restored: number(state.outcome) === 1,
			};
			assert.equal(step.restored, state.lastExposed);
			outcomes.add(`${step.ref}:${step.restored}`);
			steps.push(step);
		}
	}
	if (!steps.some((step) => step.kind === "execute")) continue;
	sequences.set(JSON.stringify(steps), { steps });
}
// Each value shown or not, and the unnumbered index, which is never shown.
assert.deepEqual(
	[...outcomes].sort(),
	["0:false", "0:true", "1:false", "1:true", "2:false", "2:true", "3:false"],
	"Every reference outcome must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
	input,
	JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/secret-reference-exposure-model.test.ts";
const child = spawnSync(
	process.execPath,
	[
		path.join(root, "packages/scripts/run-with-deadline.ts"),
		"300000",
		"--",
		process.execPath,
		path.join(root, "packages/scripts/run-vitest.ts"),
		"run",
		file,
		"--cache=false",
		"--maxWorkers=1",
		"--reporter=json",
		`--outputFile=${report}`,
	],
	{
		cwd: core,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		env: {
			...process.env,
			ELIZA_SECRET_REFERENCE_EXPOSURE_MODEL_CASES: input,
		},
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
	child.status,
	0,
	`Secret reference exposure conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	[
		"first call names credential 0",
		"first call names credential 1",
		"first call names the phone",
		"first call names an unnumbered index",
	].map((name) => `secret reference exposure model replays ${name}`),
);
console.log(
	`${sequences.size} model-generated sequences (all 7 reference outcomes) match executePlannedToolCall on a real runtime in ${checks.length} groups. Report ${report}`,
);
