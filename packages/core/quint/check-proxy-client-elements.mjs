/** Replay generated proxy header steps through isTrustedLocalRequest over real HTTP. */
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
assert.equal(model, path.join(import.meta.dirname, "ProxyClientElements.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
	readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-proxy-client-elements");
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
		"--seed=20261115",
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
const ACTIONS = [null, "compose", "send"];
const number = (value) => Number(value["#bigint"]);
const kinds = (value) => [...value["#set"]].sort();
const sequences = new Map();
const judged = new Set();
for (const file of readdirSync(directory)) {
	const states = JSON.parse(
		readFileSync(path.join(directory, file), "utf8"),
	).states;
	// Compare model variables only; ITF adds a per-state "#meta" index.
	const variables = ({ "#meta": _meta, ...state }) => JSON.stringify(state);
	const steps = [];
	let previous = states[0];
	for (const state of states.slice(1)) {
		// A stutter, or a repeated request that changes nothing, adds no step.
		if (variables(state) === variables(previous)) continue;
		const action = ACTIONS[number(state.last)];
		assert.ok(action, `Unknown model action in ${file}`);
		const sent = kinds(state.sent);
		const step = { action, sent, verdict: number(state.verdict) };
		if (action === "compose") {
			const before = new Set(kinds(previous.sent));
			const added = sent.filter((kind) => !before.has(kind));
			assert.equal(added.length, 1, `A compose adds one element in ${file}`);
			step.kind = added[0];
		} else {
			step.origin = state.origin;
			judged.add(`${sent.join(",")}:${state.origin}`);
		}
		steps.push(step);
		previous = state;
	}
	if (steps.length === 0) continue;
	sequences.set(JSON.stringify(steps), steps);
}
// Every client element set of at most two of the six kinds (1 + 6 + 15) must
// reach a request from each of the four proxy origins.
assert.equal(
	judged.size,
	88,
	"Every element set and proxy origin combination must reach a request",
);
const input = path.join(directory, "cases.json");
writeFileSync(
	input,
	JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/proxy-client-elements-model.test.ts";
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
		"--reporter=json",
		`--outputFile=${report}`,
	],
	{
		cwd: core,
		encoding: "utf8",
		env: { ...process.env, ELIZA_PROXY_CLIENT_ELEMENTS_MODEL_CASES: input },
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
	child.status,
	0,
	`Proxy client elements conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	["compose", "send"].map(
		(action) =>
			`proxy client elements model replays the proxy client elements model from ${action}`,
	),
);
console.log(
	`${sequences.size} model-generated step sequences (all 88 element set and proxy origin requests) match isTrustedLocalRequest over real HTTP in ${checks.length} replay groups. Report ${report}`,
);
