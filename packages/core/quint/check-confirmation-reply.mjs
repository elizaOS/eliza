/** Replay generated confirmation replies through requireConfirmation. */
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
assert.equal(model, path.join(import.meta.dirname, "ConfirmationReply.qnt"));
// The generated traces use the bounds and every invariant that
// check-quint.ts checks for this model.
const [modelCase] = JSON.parse(
	readFileSync(model.replace(/\.qnt$/, ".cases.json"), "utf8"),
).cases;
const output = testOutputPath("quint-confirmation-reply");
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
const sequences = new Map();
const firstReplies = new Set();
for (const file of readdirSync(directory)) {
	const states = JSON.parse(
		readFileSync(path.join(directory, file), "utf8"),
	).states;
	const language = number(states[0].language);
	const replies = [];
	let previous = "";
	for (const state of states.slice(1)) {
		const step = {
			reply: state.reply.map(number),
			status: number(state.status),
		};
		const key = JSON.stringify(step);
		// A stutter, or the same unclear reply again, changes nothing.
		if (step.reply.length === 0 || key === previous) continue;
		previous = key;
		replies.push(step);
	}
	if (replies.length === 0) continue;
	firstReplies.add(`${language}:${replies[0].reply.join(",")}`);
	sequences.set(JSON.stringify({ language, replies }), { language, replies });
}
// Seven languages, each with 3 + 9 + 27 replies of one to three words.
assert.equal(
	firstReplies.size,
	273,
	"Every one-reply case in every language must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
	input,
	JSON.stringify([...sequences.keys()].sort().map((key) => sequences.get(key))),
);
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/confirmation-reply-model.test.ts";
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
		env: { ...process.env, ELIZA_CONFIRMATION_REPLY_MODEL_CASES: input },
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
	child.status,
	0,
	`Confirmation reply conformance failed. See ${log}`,
);
const languages = [
	"English",
	"Spanish",
	"French",
	"German",
	"Korean",
	"Chinese",
	"Japanese",
];
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	languages.map(
		(name) =>
			`confirmation reply model replays the confirmation reply model in ${name}`,
	),
);
console.log(
	`${sequences.size} model-generated reply sequences (all 273 one-reply cases) match requireConfirmation in ${checks.length} languages. Report ${report}`,
);
