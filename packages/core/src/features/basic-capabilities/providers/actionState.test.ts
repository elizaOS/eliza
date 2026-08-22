/**
 * Unit tests for the ACTION_STATE provider and complete thought normalization.
 * Unicode normalization guarantees.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { actionStateProvider, normalizeThoughtText } from "./actionState.ts";

function isWellFormed(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				return false;
			}
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

describe("normalizeThoughtText Unicode boundaries", () => {
	it("preserves long surrogate-pair text completely", () => {
		const text = `${"a".repeat(3_000)}🦊${"b".repeat(50)}`;
		const out = normalizeThoughtText(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("preserves fitting emoji under limit", () => {
		const text = `${"a".repeat(100)}🦊`;
		const out = normalizeThoughtText(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone surrogates without shortening long text", () => {
		const lone = `a\uD800${"b".repeat(3000)}`;
		const out = normalizeThoughtText(lone);
		expect(out).toContain("\uFFFD");
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(lone.length);
	});

	it("sanitizes lone surrogates without truncation when under limit", () => {
		const lone = `thought \uD800 test`;
		const out = normalizeThoughtText(lone);
		expect(out).toBe("thought \uFFFD test");
		expect(isWellFormed(out)).toBe(true);
	});
});

describe("ACTION_STATE progressive projection", () => {
	it("removes recoverable bodies from every provider text carrier", async () => {
		const canary = `BEGIN_PRIVATE_PAGE_${"x".repeat(20_000)}_END`;
		const actionResult = {
			success: true,
			text: canary,
			data: { actionName: "FILE", rawBody: canary },
			promptData: {
				actionName: "FILE",
				readView: {
					reference: { kind: "file", ref: "opaque-file", revision: "r1" },
					slice: {
						range: { unit: "byte", start: 0, end: 10, total: 20 },
						hasPrevious: false,
						hasMore: true,
						nextOffset: 10,
						revision: "r1",
						completeness: "partial-recoverable",
						sliceSha256: createHash("sha256").update(canary).digest("hex"),
					},
				},
			},
		};
		const result = await actionStateProvider.get(
			{
				getSetting: () => true,
				getMemories: async () => [],
			} as never,
			{ roomId: "00000000-0000-0000-0000-000000000001" } as never,
			{
				data: {
					actionResults: [actionResult],
					workingMemory: {
						file: { actionName: "FILE", result: actionResult, timestamp: 1 },
					},
					actionPlan: {
						thought: "read",
						currentStep: 1,
						totalSteps: 2,
						steps: [
							{ action: "FILE", status: "completed", result: actionResult },
							{ action: "REPLY", status: "pending" },
						],
					},
				},
				values: {},
				text: "",
			} as never,
		);

		expect(result.text).toContain("opaque-file");
		expect(result.text).not.toContain("BEGIN_PRIVATE_PAGE");
		expect(JSON.stringify(result.data)).toContain("BEGIN_PRIVATE_PAGE");
	});
});
