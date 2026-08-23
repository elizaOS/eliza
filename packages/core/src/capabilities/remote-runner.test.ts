/**
 * Verifies the deterministic sandbox entry-type normalization used by remote
 * runner clients. The suite drives the real helper without mocks.
 */
import { describe, expect, it } from "vitest";
import { normalizeSandboxEntryType } from "./remote-runner";

describe("normalizeSandboxEntryType", () => {
	it.each([
		["dir", "dir"],
		["directory", "dir"],
		["file", "file"],
		["symlink", "symlink"],
		["socket", "other"],
		["", "other"],
		[undefined, "other"],
	] as const)("normalizes %s to %s", (input, expected) => {
		expect(normalizeSandboxEntryType(input)).toBe(expected);
	});
});
