/** Require real runtime, room lease, event, and file receipt checks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const core = path.resolve(import.meta.dirname, "..");
assert.equal(
	path.resolve(process.argv[2] ?? ""),
	path.join(import.meta.dirname, "RunTerminalOwner.qnt"),
);
const output = testOutputPath("quint-run-terminal-owner");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/run-terminal-owner.integration.test.ts";
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
	{ cwd: core, encoding: "utf8" },
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(child.status, 0, `Run terminal conformance failed. See ${log}`);
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	[
		"joins an admitted terminal subscriber after a sibling rejects",
		"keeps the first terminal outcome and skips work after failed delivery",
		"preserves the first observed event rejection and skips later event names",
	],
);
console.log(`Passed ${checks.length} run terminal tests. Report ${report}`);
