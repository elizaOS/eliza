/**
 * Locks the affected-scoped CI lanes' vacuous-case reporting (#19351): a lane
 * that executes zero packages must be distinguishable from a passing lane in
 * the PR checks list itself. Each affected-scoped job carries a dynamic name
 * that appends "— not affected" from the same `changes` output that gates its
 * work, and the skip step emits a `::notice::` annotation for the job log.
 * Reads the real workflow file; deterministic, no mocks.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const ciContent = readFileSync(
	join(repoRoot, ".github", "workflows", "ci.yml"),
	"utf8",
);

// Each lane's job-name gate must be the exact negation of the condition that
// runs its work, so "— not affected" can never appear on a job that executed.
const lanes = [
	{
		job: "Tests (server)",
		gate: "needs.changes.outputs.server != 'true'",
	},
	{
		job: "Tests (client)",
		gate: "needs.changes.outputs.client != 'true'",
	},
	{
		job: "Tests (plugins)",
		gate: "needs.changes.outputs.plugins != 'true'",
	},
	{
		job: "Smoke",
		gate: "needs.changes.outputs.zero_key != 'true'",
	},
	{
		job: "Smoke lanes",
		gate: "needs.changes.outputs.desktop != 'true' && needs.changes.outputs.cloud != 'true' && needs.changes.outputs.zero_key != 'true'",
	},
] as const;

describe("affected-scoped lane vacuous-case visibility (#19351)", () => {
	test.each(lanes)(
		"$job job name appends '— not affected' from its own gate",
		({ job, gate }) => {
			const dynamicName = `name: "${job}\${{ ${gate} && ' — not affected' || '' }}"`;
			expect(ciContent).toContain(dynamicName);
		},
	);

	test.each(lanes)(
		"$job skip step annotates the vacuous case under the same gate",
		({ gate }) => {
			// The skip step pairs the gated ::notice with the dynamic job name;
			// find at least one not-affected step guarded by this exact gate.
			const stepPattern = new RegExp(
				`- name: — not affected [^\\n]*\\n\\s+if: ${gate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\s+run: echo "::notice::`,
			);
			expect(ciContent).toMatch(stepPattern);
		},
	);

	test("a plain static name never shadows the dynamic one", () => {
		for (const { job } of lanes) {
			expect(ciContent).not.toContain(`    name: ${job}\n`);
		}
	});
});
