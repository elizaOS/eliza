/**
 * Fail-closed SKILL.md frontmatter nest bound for skill-items.
 *
 * origin/develop `splitFrontmatter` called `yaml.parse` with no depth cap or
 * try/catch. An 8000-deep flow map (`{a:{a:…}}`) throws
 * `YAMLParseError: Maximum call stack size exceeded` (~50ms) and crashes
 * skill-refinement prepare. The bound rejects before that walk.
 */
import { describe, expect, it } from "vitest";
import {
	_splitFrontmatter,
	MAX_SKILL_FRONTMATTER_YAML_DEPTH,
} from "./skill-items.ts";

function wrapFrontmatter(yamlText: string): string {
	return `---\n${yamlText}\n---\nbody\n`;
}

function flowMap(depth: number): string {
	return `${"{a:".repeat(depth)}1${"}".repeat(depth)}`;
}

describe("skill-items SKILL.md frontmatter nest bound", () => {
	it("parses shallow installer frontmatter", () => {
		const parsed = _splitFrontmatter(
			wrapFrontmatter("name: demo\ndescription: a skill\n"),
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.frontmatter.name).toBe("demo");
		expect(parsed?.frontmatter.description).toBe("a skill");
		expect(parsed?.body).toBe("body\n");
	});

	it("accepts a flow map at the nest bound", () => {
		const parsed = _splitFrontmatter(
			wrapFrontmatter(`nest: ${flowMap(MAX_SKILL_FRONTMATTER_YAML_DEPTH)}`),
		);
		expect(parsed).not.toBeNull();
		expect(parsed?.frontmatter).toHaveProperty("nest");
	});

	it("returns null for a flow map one level over the nest bound", () => {
		expect(
			_splitFrontmatter(
				wrapFrontmatter(
					`nest: ${flowMap(MAX_SKILL_FRONTMATTER_YAML_DEPTH + 1)}`,
				),
			),
		).toBeNull();
	});

	it("fail-closes on the 8000-deep flow payload that overflowed yaml.parse", () => {
		const started = performance.now();
		expect(_splitFrontmatter(wrapFrontmatter(flowMap(8000)))).toBeNull();
		expect(performance.now() - started).toBeLessThan(50);
	});

	it("returns null for malformed YAML instead of throwing", () => {
		expect(
			_splitFrontmatter(wrapFrontmatter("name: [unterminated")),
		).toBeNull();
	});
});
