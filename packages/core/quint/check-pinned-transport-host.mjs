/** Replay generated pinned-transport scenarios against real local servers. */
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
assert.equal(model, path.join(import.meta.dirname, "PinnedTransportHost.qnt"));
const output = testOutputPath("quint-pinned-transport-host");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
execFileSync(
	process.execPath,
	[
		path.join(root, "node_modules/@informalsystems/quint/dist/src/cli.js"),
		"run",
		model,
		"--main=PinnedTransportHost",
		"--backend=typescript",
		"--seed=20261113",
		"--max-samples=100",
		"--n-traces=100",
		"--max-steps=3",
		"--invariant=Delivered",
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
			["hostKind", "scheme", "sni", "outcome"].map((key) => [
				key,
				Number(state[key]["#bigint"]),
			]),
		);
		fields.hostHeaderBracketed = state.hostHeaderBracketed;
		cases.set(`${fields.hostKind}:${fields.scheme}`, fields);
	}
}
assert.equal(
	cases.size,
	6,
	"All six host and scheme scenarios must be generated",
);
const ordered = [...cases.values()].sort(
	(a, b) => a.hostKind - b.hostKind || a.scheme - b.scheme,
);
const input = path.join(directory, "cases.json");
writeFileSync(input, JSON.stringify(ordered));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/pinned-transport-host.integration.test.ts";
const child = spawnSync(
	process.execPath,
	[
		path.join(root, "packages/scripts/run-with-deadline.ts"),
		"120000",
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
		env: { ...process.env, ELIZA_PINNED_TRANSPORT_MODEL_CASES: input },
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
	child.status,
	0,
	`Pinned transport conformance failed. See ${log}`,
);
const hosts = ["localhost", "127.0.0.1", "[::1]"];
const schemes = ["http", "https"];
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	ordered.map(
		({ hostKind, scheme }) =>
			`pinned transport host, Host header and TLS server name matches the generated pinned transport outcome for ${schemes[scheme]}://${hosts[hostKind]}`,
	),
);
console.log(
	`Passed ${checks.length} model-generated pinned transport cases against real local servers. Report ${report}`,
);
