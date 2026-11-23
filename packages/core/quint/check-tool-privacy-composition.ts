/** Bind the finite state projection to the existing production regression suite. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const packageRoot = path.join(root, "packages/core");
const model = path.relative(root, path.resolve(root, process.argv[2] ?? ""));
const testFile = "packages/core/test/pii-swap-restore.test.ts";
const requiredTests = [
	"private action execution reverses nested privacy layers privately restores person-nested contact data before sms_send validation",
	"private action execution reverses nested privacy layers privately restores org-nested contact data before sms_send validation",
	"private action execution reverses nested privacy layers privately restores person-nested contact data before phone_dial validation",
	"private action execution reverses nested privacy layers privately restores org-nested contact data before phone_dial validation",
	"private action execution reverses nested privacy layers rejects an unknown inner reference expanded from person before the handler",
	"private action execution reverses nested privacy layers rejects an unknown inner reference expanded from org before the handler",
	"private action execution reverses nested privacy layers preserves person-recognized protocol spans through both local NER passes and executes sms_send",
	"private action execution reverses nested privacy layers preserves org-recognized protocol spans through both local NER passes and executes phone_dial",
	"private action execution reverses nested privacy layers preserves an unknown current reference for strict rejection before execution",
	"private action execution reverses nested privacy layers masks only own protocol spans from local recognition with unchanged offsets",
	"private action execution reverses nested privacy layers grounds SMS and dial with both privacy layers under hard trajectory logging opt-out",
	"PseudonymSession restore restores the real address across two learn passes",
	"PseudonymSession restore skips a surrogate followed only by punctuation",
	"PseudonymSession restore still masks real text around an echoed surrogate",
	"PseudonymSession restore restores a surrogate echoed twice to the real address",
	"model dispatch with PII swap restores the real address after one model call",
	"model dispatch with PII swap masks an address a pre_model hook adds and restores both",
	"model dispatch with PII swap restores the real address when a second call echoes the first surrogate",
	"model dispatch secret swap for IMAGE swaps a secret in the prompt and leaves input image fields intact",
	"ELIZA_BRAIN_PROVIDER pin names the stale pinned provider instead of a generic handler error",
];
assert.equal(
	model,
	"packages/core/quint/ToolPrivacyComposition.qnt",
	`Unexpected privacy model ${model}`,
);
const output = testOutputPath("quint-tool-privacy-composition");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const report = path.join(directory, "vitest.json");
const log = path.join(directory, "vitest.log");
const child = spawnSync(
	process.execPath,
	[
		path.join(root, "packages/scripts/run-with-deadline.ts"),
		"180000",
		"--",
		process.execPath,
		path.join(root, "packages/scripts/run-vitest.ts"),
		"run",
		"test/pii-swap-restore.test.ts",
		"--cache=false",
		"--maxWorkers=1",
		"--reporter=json",
		`--outputFile=${report}`,
	],
	{
		cwd: packageRoot,
		env: process.env,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	},
);
writeFileSync(log, `${child.stdout ?? ""}\n${child.stderr ?? ""}`);
if (child.error) throw child.error;
assert.equal(
	child.signal,
	null,
	`Conformance terminated by ${child.signal}. See ${log}`,
);
assert.equal(child.status, 0, `Conformance failed. See ${log}`);
const tests = requireVitestConformance(
	JSON.parse(readFileSync(report, "utf8")),
	path.join(root, testFile),
	requiredTests,
);
const inputs = Object.fromEntries(
	[
		model,
		model.replace(/\.qnt$/, ".cases.json"),
		...JSON.parse(
			readFileSync(
				path.join(root, model.replace(/\.qnt$/, ".cases.json")),
				"utf8",
			),
		).sources,
		"packages/core/quint/check-tool-privacy-composition.ts",
	].map((file) => [
		file,
		createHash("sha256")
			.update(readFileSync(path.join(root, file)))
			.digest("hex"),
	]),
);
writeFileSync(
	path.join(directory, "evidence.json"),
	`${JSON.stringify({ model, inputs, tests, report }, null, 2)}\n`,
);
console.log(
	`Conformance passed ${tests.length} required cases. Evidence ${directory}`,
);
