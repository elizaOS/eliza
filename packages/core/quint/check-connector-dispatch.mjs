/** Require real runtime routing and local dispatch across registry changes. */
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
	path.join(import.meta.dirname, "ConnectorDispatch.qnt"),
);
const output = testOutputPath("quint-core-connector-registry");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const file = "test/connector-registry.integration.test.ts";
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
assert.equal(child.status, 0, `Connector conformance failed. See ${log}`);
const checks = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(core, file),
	[
		"keeps internal transport and descriptor publication separate",
		"selects exact routes and distinguishes exact from source-wide removal",
		"retains the admitted handler across voice-gate replacement",
		"retains the admitted handler across voice-gate unregister",
		"propagates admitted failure without retrying the current fallback",
		"keeps edit bound to its descriptor across replacement and removal",
		"keeps typing bound to its descriptor across replacement and removal",
		"keeps stop typing bound to its descriptor across replacement and removal",
		"keeps create thread bound to its descriptor across replacement and removal",
		"keeps post to thread bound to its descriptor across replacement and removal",
		"keeps reaction bound to its descriptor across replacement and removal",
		"retains an enumerated postHandler while post registrations change",
		"retains an enumerated fetchFeed while post registrations change",
		"retains an enumerated searchPosts while post registrations change",
	],
);
console.log(`Passed ${checks.length} local connector tests. Report ${report}`);
