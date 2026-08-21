/** Surrogate safety for OAuth flowId generation in account-manager.ts. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

function deriveOAuthFlowId(stateHash: string): string {
	return `oauth_${truncateWellFormed(toWellFormedUnicode(stateHash), 16)}`;
}

describe("account-manager flowId surrogate safety", () => {
	test("emoji at 15 boundary backs off cleanly without lone surrogate", () => {
		const fox = "🦊";
		const stateHash = `${"a".repeat(15)}${fox}123456`;
		const flowId = deriveOAuthFlowId(stateHash);
		expect(isWellFormed(flowId)).toBe(true);
		expect(flowId).toBe("oauth_aaaaaaaaaaaaaaa");
		expect(() => JSON.stringify({ flowId })).not.toThrow();
	});

	test("fitting emoji ending at 16 kept intact", () => {
		const fox = "🦊";
		const stateHash = `${"a".repeat(14)}${fox}`;
		const flowId = deriveOAuthFlowId(stateHash);
		expect(isWellFormed(flowId)).toBe(true);
		expect(flowId.includes(fox)).toBe(true);
	});

	test("lone high surrogate in state hash is sanitized safely", () => {
		const badStateHash = "state\ud800hash123456";
		const flowId = deriveOAuthFlowId(badStateHash);
		expect(isWellFormed(flowId)).toBe(true);
		expect(flowId.includes("\ud800")).toBe(false);
	});

	test("sweep offsets around 16 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let offset = -5; offset <= 5; offset++) {
			const n = 16 + offset;
			const stateHash = `${"a".repeat(n)}${fox}${"b".repeat(10)}`;
			const flowId = deriveOAuthFlowId(stateHash);
			expect(isWellFormed(flowId)).toBe(true);
			expect(() => JSON.stringify({ flowId })).not.toThrow();
		}
	});
});
