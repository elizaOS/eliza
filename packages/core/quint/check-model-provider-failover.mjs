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

// Every reachable dispatch: TEXT_TO_SPEECH stops at its first registration
// (9 outcomes); TEXT_SMALL continues only after a refused connection or an
// exhausted budget (6 + 12 + 36 + 18 + 9 = 81).
const EXPECTED_CASES = 90;
const root = path.resolve(import.meta.dirname, "../../..");
const model = path.resolve(process.argv[2]);
const output = testOutputPath("quint-model-provider-failover");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
	process.execPath,
	[
		path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
		"run",
		model,
		"--main=ModelProviderFailover",
		"--backend=typescript",
		"--seed=20261113",
		"--max-samples=12000",
		"--n-traces=12000",
		"--max-steps=4",
		"--invariant=RefusedConnectionFailsOver",
		`--out-itf=${path.join(directory, "trace-{seq}.itf.json")}`,
		"--verbosity=0",
	],
	{ stdio: "inherit" },
);
const number = (value) => Number(value["#bigint"]);
const cases = new Map();
for (const file of readdirSync(directory)) {
	const { states } = JSON.parse(
		readFileSync(path.join(directory, file), "utf8"),
	);
	const state = states.at(-1);
	if (number(state.phase) === 0) continue;
	const outcomes = [state.outcome0, state.outcome1, state.outcome2].map(number);
	const attempts = state.attempts.map(number);
	const modelCase = {
		modelType: number(state.modelType),
		outcomes,
		attempts,
		phase: number(state.phase),
		answeredBy: number(state.answeredBy),
		rejectedWith: number(state.rejectedWith),
	};
	// Outcomes of registrations the dispatch never reached do not change it.
	const key = `${modelCase.modelType}:${attempts.map((registration) => `${registration}=${outcomes[registration]}`).join(",")}`;
	if (!cases.has(key)) cases.set(key, modelCase);
}
assert.equal(
	cases.size,
	EXPECTED_CASES,
	"Every reachable failover dispatch must reach conformance",
);
const input = path.join(directory, "cases.json");
writeFileSync(
	input,
	JSON.stringify(
		[...cases.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, value]) => value),
	),
);
const core = path.join(root, "packages/core");
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const child = spawnSync(
	process.execPath,
	[
		path.join(root, "packages/scripts/run-with-deadline.ts"),
		"300000",
		"--",
		process.execPath,
		path.join(root, "packages/scripts/run-vitest.ts"),
		"run",
		"test/model-provider-failover.model.test.ts",
		"--cache=false",
		"--reporter=json",
		`--outputFile=${report}`,
	],
	{
		cwd: core,
		encoding: "utf8",
		env: {
			...process.env,
			ELIZA_MODEL_PROVIDER_FAILOVER_MODEL_CASES: input,
		},
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
	child.status,
	0,
	`Provider failover runtime conformance failed. See ${log}`,
);
const summary = JSON.parse(readFileSync(report, "utf8"));
assert.equal(summary.success, true);
assert.equal(summary.numFailedTests, 0);
assert.equal(summary.numTotalTests, EXPECTED_CASES + 1);
assert.equal(summary.numPassedTests, EXPECTED_CASES + 1);
console.log(
	`${EXPECTED_CASES} model-generated failover dispatches match AgentRuntime.useModel. Report ${report}`,
);
