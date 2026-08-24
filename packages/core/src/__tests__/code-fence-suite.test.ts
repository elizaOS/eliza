/**
 * Unit tests for code fence unwrapping and language delimiter parsing.
 * Validates whole code fence unwrapping, unsupported language rejection, and whitespace trimming.
 */
import { describe, expect, it } from "vitest";
import { unwrapWholeCodeFence } from "../utils/code-fence.ts";

describe("code-fence", () => {
	it("returns null for non-fence or malformed strings", () => {
		expect(unwrapWholeCodeFence("plain text", ["json"])).toBeNull();
		expect(unwrapWholeCodeFence("```", ["json"])).toBeNull();
		expect(unwrapWholeCodeFence("```json", ["json"])).toBeNull();
		expect(unwrapWholeCodeFence("hello```", ["json"])).toBeNull();
	});

	it("unwraps matching language fences cleanly", () => {
		const jsonFence = '```json\n{"foo": "bar"}\n```';
		expect(unwrapWholeCodeFence(jsonFence, ["json"])).toBe('{"foo": "bar"}');

		const upperJsonFence = '```JSON\n{"foo": "bar"}\n```';
		expect(unwrapWholeCodeFence(upperJsonFence, ["json"])).toBe(
			'{"foo": "bar"}',
		);
	});

	it("unwraps bare code fences without language tags", () => {
		const bareFence = "```\nhello world\n```";
		expect(unwrapWholeCodeFence(bareFence, ["json"])).toBe("hello world");

		const compactBare = "```true```";
		expect(unwrapWholeCodeFence(compactBare, ["json"])).toBe("true");
	});

	it("rejects fences with unsupported explicit language identifiers", () => {
		const xmlFence = "```xml\n<data></data>\n```";
		expect(unwrapWholeCodeFence(xmlFence, ["json"])).toBeNull();
	});
});
