/** Replay generated PII map-stage sequences through PiiScrubService. */
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
assert.equal(model, path.join(import.meta.dirname, "PiiPseudonymMapStage.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model, so a trace that loses a pseudonym
// stops the run instead of becoming an expected case.
const [modelCase] = JSON.parse(
	readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-pii-pseudonym-map-stage");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
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
		"--seed=20261114",
		`--max-samples=${modelCase.samples}`,
		`--n-traces=${modelCase.samples}`,
		`--max-steps=${modelCase.maxSteps}`,
		"--invariants",
		...modelCase.invariants,
		`--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
		"--verbosity=0",
	],
	{ stdio: "inherit" },
);
const number = (value) => Number(value["#bigint"]);
const entries = (value) => value["#map"];
const byItem = (value) =>
	Object.fromEntries(
		entries(value).map(([key, entry]) => [number(key), entry]),
	);
// Observable events: phase changes of one item between two states.
const EVENTS = {
	"idle>queued": "enter",
	"queued>loaded": "load",
	"loaded>saved": "complete",
	"loaded>backoff": "reject",
	"backoff>queued": "retry",
};
const sequences = new Map();
for (const file of readdirSync(directory)) {
	if (!file.endsWith(".itf.json")) continue;
	const states = JSON.parse(
		readFileSync(path.join(directory, file), "utf8"),
	).states;
	const finalPhase = byItem(states.at(-1).phase);
	// Only sequences that save both items are replayed; shorter traces are
	// prefixes of them.
	if (finalPhase[1] !== "saved" || finalPhase[2] !== "saved") continue;
	const person = byItem(states[0].person);
	const arrival = [];
	const steps = [];
	for (let index = 1; index < states.length; index += 1) {
		const before = byItem(states[index - 1].phase);
		const state = states[index];
		const after = byItem(state.phase);
		for (const item of [1, 2]) {
			if (before[item] === after[item]) continue;
			const event = EVENTS[`${before[item]}>${after[item]}`];
			assert.ok(event, `Unknown phase change in ${file}`);
			if (event === "enter") arrival.push(item);
			if (event === "enter" || event === "retry") continue;
			const stored = byItem(state.stored);
			const local = byItem(byItem(state.local)[item]);
			const token = event === "load" ? number(local[number(person[item])]) : 0;
			// "<event> <item> <token> <stored person 1> <stored person 2>"
			steps.push(
				[event, item, token, number(stored[1]), number(stored[2])].join(" "),
			);
		}
	}
	const sequence = { second: number(person[2]), arrival, steps };
	sequences.set(JSON.stringify(sequence), sequence);
}
// Both arrival orders, both person choices, and no rejection or one
// rejection of the first or the second item to load.
assert.equal(
	sequences.size,
	12,
	"Every arrival order, person choice and rejection must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
	input,
	JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/pii-pseudonym-map-stage-model.test.ts";
const child = spawnSync(
	process.execPath,
	[
		path.join(root, "packages/scripts/run-with-deadline.ts"),
		"240000",
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
		env: { ...process.env, ELIZA_PII_MAP_STAGE_MODEL_CASES: input },
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `PII map stage conformance failed. See ${log}`);
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	[
		...[1, 2].flatMap((first) =>
			[1, 2].map(
				(second) =>
					`PiiPseudonymMapStage model replays item ${first} arriving first with item 2 naming person ${second}`,
			),
		),
		"PiiPseudonymMapStage model keeps a request with its own assignments out of the map stage",
	],
);
console.log(
	`${sequences.size} model-generated sequences match PiiScrubService in ${checks.length} tests. Report ${report}`,
);
