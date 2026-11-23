/** Replay generated spawn-env steps through sanitizeSpawnEnv and real git. */
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
assert.equal(model, path.join(import.meta.dirname, "SpawnEnvGitHelpers.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
	readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-spawn-env-git-helpers");
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
const ACTIONS = [null, "write", "fetchGit", "fetchHttps"];
const number = (value) => Number(value["#bigint"]);
const keys = (value) => [...value["#set"]].sort();
const sequences = new Map();
const fetchedOverlays = new Set();
for (const file of readdirSync(directory)) {
	const states = JSON.parse(
		readFileSync(path.join(directory, file), "utf8"),
	).states;
	// Compare model variables only; ITF adds a per-state "#meta" index.
	const variables = ({ "#meta": _meta, ...state }) => JSON.stringify(state);
	const steps = [];
	let previous = states[0];
	for (const state of states.slice(1)) {
		// A stutter, or a repeated fetch that changes nothing, adds no step.
		if (variables(state) === variables(previous)) continue;
		const action = ACTIONS[number(state.last)];
		assert.ok(action, `Unknown model action in ${file}`);
		const overlay = keys(state.overlay);
		const step = {
			action,
			overlay,
			outcome: number(state.outcome),
			child: keys(state.child),
		};
		if (action === "write") {
			const before = new Set(keys(previous.overlay));
			const added = overlay.filter((key) => !before.has(key));
			assert.equal(added.length, 1, `A write adds one key in ${file}`);
			step.key = added[0];
		} else {
			fetchedOverlays.add(`${action}:${overlay.join(",")}`);
		}
		steps.push(step);
		previous = state;
	}
	if (steps.length === 0) continue;
	sequences.set(JSON.stringify(steps), steps);
}
// Every subset of the four overlay keys must reach both a git:// and an https
// fetch.
assert.equal(
	fetchedOverlays.size,
	32,
	"Every overlay and transport combination must reach a git fetch",
);
const input = path.join(directory, "cases.json");
writeFileSync(
	input,
	JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/spawn-env-git-helpers-model.test.ts";
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
		env: { ...process.env, ELIZA_SPAWN_ENV_GIT_HELPERS_MODEL_CASES: input },
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
	child.status,
	0,
	`Spawn env git helpers conformance failed. See ${log}`,
);
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	["write", "fetchGit", "fetchHttps"].map(
		(action) =>
			`spawn env git helpers model replays the spawn env git helpers model from ${action}`,
	),
);
console.log(
	`${sequences.size} model-generated step sequences (all 32 overlay and transport fetches) match sanitizeSpawnEnv and real git in ${checks.length} replay groups. Report ${report}`,
);
