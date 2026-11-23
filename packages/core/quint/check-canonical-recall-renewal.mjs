/** Replay generated recall-renewal steps through searchCanonicalConversationMemories. */
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
	path.join(import.meta.dirname, "CanonicalRecallRenewal.qnt"),
);
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
	readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-canonical-recall-renewal");
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
const ACTIONS = [null, "expire", "end", "join", "search", "cancel"];
const number = (value) => Number(value["#bigint"]);
const sequences = new Map();
const searchedConditions = new Set();
for (const file of readdirSync(directory)) {
	const states = JSON.parse(
		readFileSync(path.join(directory, file), "utf8"),
	).states;
	// Compare model variables only; ITF adds a per-state "#meta" index.
	const variables = ({ "#meta": _meta, ...state }) => JSON.stringify(state);
	const steps = [];
	// How the turn stopped before each search: running, ended or cancelled.
	let stopped = "running";
	let previous = variables(states[0]);
	for (const state of states.slice(1)) {
		const key = variables(state);
		// A stutter, or a repeated search that changes nothing, adds no step.
		if (key === previous) continue;
		previous = key;
		const action = ACTIONS[number(state.last)];
		assert.ok(action, `Unknown model action in ${file}`);
		if (action === "end" || action === "cancel") stopped = action;
		if (action === "search") {
			searchedConditions.add(`${state.atFresh}:${stopped}:${state.atChanged}`);
		}
		steps.push({
			action,
			fresh: state.fresh,
			active: state.active,
			changed: state.changed,
			outcome: number(state.outcome),
		});
	}
	if (steps.length === 0) continue;
	sequences.set(JSON.stringify(steps), steps);
}
// Fresh or expired evidence; a running, ended or cancelled turn; an unchanged
// or changed census.
assert.equal(
	searchedConditions.size,
	12,
	"Every evidence, turn and census combination must reach a search",
);
const input = path.join(directory, "cases.json");
writeFileSync(
	input,
	JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/canonical-recall-renewal-model.test.ts";
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
		env: { ...process.env, ELIZA_CANONICAL_RECALL_RENEWAL_MODEL_CASES: input },
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
	child.status,
	0,
	`Canonical recall renewal conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	["expire", "end", "cancel", "join", "search"].map(
		(action) =>
			`canonical recall renewal model replays the canonical recall renewal model from ${action}`,
	),
);
console.log(
	`${sequences.size} model-generated step sequences (all 12 search conditions) match searchCanonicalConversationMemories in ${checks.length} replay groups. Report ${report}`,
);
