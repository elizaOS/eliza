import { describe, expect, it } from "vitest";
import { REDACTION_FAILED_VALUE } from "./log-redaction.js";
import { redactLogArgs } from "./redact.js";

describe("redactLogArgs fails closed", () => {
	it("masks a throwing getter per key and still redacts sibling credentials", () => {
		const payload = {
			apiKey: "sk-live-sibling-credential-value",
			note: "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
			get lazy(): string {
				throw new Error("lazy relation not loaded");
			},
		};
		let redacted: unknown[] = [];
		expect(() => {
			redacted = redactLogArgs(["context", payload]);
		}).not.toThrow();
		const serialized = JSON.stringify(redacted);
		expect(serialized).not.toContain("sk-live-sibling-credential-value");
		expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
		const clone = redacted[1] as Record<string, unknown>;
		expect(clone.apiKey).toBe("[REDACTED]");
		expect(clone.lazy).toBe(REDACTION_FAILED_VALUE);
		expect(redacted[0]).toBe("context");
	});

	it("collapses an unwalkable argument to the failure marker instead of throwing", () => {
		const hostile = new Proxy(
			{ secret: "hunter2-hunter2-hunter2" },
			{
				ownKeys() {
					throw new Error("ownKeys trap");
				},
			},
		);
		let redacted: unknown[] = [];
		expect(() => {
			redacted = redactLogArgs([hostile, "tail"]);
		}).not.toThrow();
		expect(redacted).toEqual([REDACTION_FAILED_VALUE, "tail"]);
	});
});
