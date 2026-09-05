/**
 * Unit tests for `installSkillDependency` command-injection safety — asserts
 * malicious package names are rejected before reaching the package manager.
 */

import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "../parser";
import {
	getInstallPlan,
	installSkillDependencies,
	installSkillDependency,
} from "./install";

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

describe("installSkillDependencies over list-frontmatter skills (issue #29157)", () => {
	// A SKILL.md written with normal YAML block-sequence frontmatter (the format
	// the README documents) previously parsed `otto.install` into a merged
	// object. `installSkillDependencies` then did `installOptions.length === 0`
	// (undefined === 0 -> false) and fell into `for (const option of ...)`,
	// throwing `TypeError: installOptions is not iterable`. This proves the
	// canonical parse-then-install path returns results and never throws.
	const listSkillMd = [
		"---",
		"name: needs-missing-bin",
		"description: Requires a binary that is not installed on this host.",
		"metadata:",
		"  otto:",
		"    requires:",
		"      bins:",
		"        - eliza-absent-tool",
		"    install:",
		"      - id: brew",
		"        kind: brew",
		"        formula: eliza-absent-tool",
		'        bins: ["eliza-absent-tool"]',
		"      - id: apt",
		"        kind: apt",
		"        package: eliza-absent-tool",
		'        bins: ["eliza-absent-tool"]',
		"---",
		"body",
	].join("\n");

	it("dry-runs a list-frontmatter skill without throwing", async () => {
		const frontmatter = parseFrontmatter(listSkillMd).frontmatter;
		if (!frontmatter) throw new Error("expected parsed frontmatter");
		expect(Array.isArray(frontmatter.metadata?.otto?.install)).toBe(true);

		const results = await installSkillDependencies(
			{ slug: "needs-missing-bin", frontmatter },
			{ dryRun: true },
		);

		expect(Array.isArray(results)).toBe(true);
		// The missing bin has install options, so the iterate-and-plan path runs
		// exactly once and the produced result references that binary's option —
		// deterministically, regardless of which package managers this host has.
		expect(results).toHaveLength(1);
		expect(results[0].option.bins).toContain("eliza-absent-tool");
	});

	it("builds an install plan from a list-frontmatter skill", async () => {
		const frontmatter = parseFrontmatter(listSkillMd).frontmatter;
		if (!frontmatter) throw new Error("expected parsed frontmatter");
		const plan = await getInstallPlan({
			slug: "needs-missing-bin",
			frontmatter,
		});

		expect(plan.requiredBins).toEqual(["eliza-absent-tool"]);
		expect(plan.missingBins).toEqual(["eliza-absent-tool"]);
		expect(plan.recommendedOptions.length).toBeGreaterThan(0);
	});

	// A SKILL.md whose block sequences are documented with inline YAML comments
	// before the first item. The comment previously misrouted both lists to the
	// nested-object path, so `requires.bins` collapsed to `{}` and `install`
	// merged into one object; the plan then reported no required binary and no
	// install option, silently skipping dependency installation.
	const commentedListSkillMd = [
		"---",
		"name: needs-missing-bin-commented",
		"description: Requires a binary that is not installed, documented with comments.",
		"metadata:",
		"  otto:",
		"    requires:",
		"      bins:",
		"        # the tool this skill shells out to",
		"        - eliza-absent-tool",
		"    install:",
		"      # homebrew is the primary channel",
		"      - id: brew",
		"        kind: brew",
		"        formula: eliza-absent-tool",
		'        bins: ["eliza-absent-tool"]',
		"      # fall back to apt on Debian/Ubuntu",
		"      - id: apt",
		"        kind: apt",
		"        package: eliza-absent-tool",
		'        bins: ["eliza-absent-tool"]',
		"---",
		"body",
	].join("\n");

	it("builds an install plan when comments precede both block lists", async () => {
		const frontmatter = parseFrontmatter(commentedListSkillMd).frontmatter;
		if (!frontmatter) throw new Error("expected parsed frontmatter");
		expect(Array.isArray(frontmatter.metadata?.otto?.install)).toBe(true);

		const plan = await getInstallPlan({
			slug: "needs-missing-bin-commented",
			frontmatter,
		});

		expect(plan.requiredBins).toEqual(["eliza-absent-tool"]);
		expect(plan.missingBins).toEqual(["eliza-absent-tool"]);
		expect(plan.recommendedOptions.length).toBeGreaterThan(0);

		const results = await installSkillDependencies(
			{ slug: "needs-missing-bin-commented", frontmatter },
			{ dryRun: true },
		);
		expect(results).toHaveLength(1);
		expect(results[0].option.bins).toContain("eliza-absent-tool");
	});

	it("returns [] for a skill without install options and does not throw", async () => {
		const results = await installSkillDependencies(
			{ slug: "bare", frontmatter: { name: "bare", description: "No otto." } },
			{ dryRun: true },
		);
		expect(results).toEqual([]);
	});
});
