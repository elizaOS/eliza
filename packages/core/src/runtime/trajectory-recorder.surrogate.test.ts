/** Verifies trajectory capture preserves complete Unicode-safe inputs and outputs. */

import { describe, expect, test } from "vitest";
import {
	captureSkillInvocationIO,
	captureToolStageIO,
	encodeTrajectoryFieldValue,
} from "./trajectory-recorder";

describe("lossless trajectory capture", () => {
	test("tool-stage capture preserves complete input, output, and error", () => {
		const value = `${"x".repeat(100_000)}🦊tail`;
		const captured = captureToolStageIO({
			input: value,
			output: value,
			error: value,
		});
		expect(captured).toEqual({ input: value, output: value, errorText: value });
	});

	test("skill capture preserves complete args and result", () => {
		const value = `${"y".repeat(100_000)}🦊tail`;
		expect(captureSkillInvocationIO({ args: value, result: value })).toEqual({
			args: value,
			result: value,
		});
	});

	test("record normalization repairs lone surrogates without shortening content", () => {
		const input = `${"z".repeat(70_000)}\uD800tail`;
		const encoded = encodeTrajectoryFieldValue({ input });
		const parsed = JSON.parse(encoded) as { input: string };
		expect(parsed.input).toBe(`${"z".repeat(70_000)}�tail`);
	});
});
