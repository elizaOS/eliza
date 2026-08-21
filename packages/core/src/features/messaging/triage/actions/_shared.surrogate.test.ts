/** Surrogate safety for message triage placeholder signature stripping. */
import { describe, expect, test } from "vitest";
import { parseDraftReplyParams } from "./_shared.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("triage actions _shared surrogate safety", () => {
	test("emoji preceding placeholder signature stripped cleanly without lone surrogate", () => {
		const fox = "🦊";
		const input = `Here is the reply message ${fox}\nThanks,\n[Your Name]`;
		const res = parseDraftReplyParams({
			parameters: {
				messageId: "msg-123",
				body: input,
			},
		});
		expect("body" in res).toBe(true);
		if ("body" in res) {
			expect(isWellFormed(res.body)).toBe(true);
			expect(res.body).toBe(`Here is the reply message ${fox}`);
		}
	});

	test("bare placeholder signature with trailing emoji parsed intact", () => {
		const fox = "🦊";
		const input = `Draft content ${fox}\n[Name]`;
		const res = parseDraftReplyParams({
			parameters: {
				messageId: "msg-123",
				body: input,
			},
		});
		expect("body" in res).toBe(true);
		if ("body" in res) {
			expect(isWellFormed(res.body)).toBe(true);
			expect(res.body).toBe(`Draft content ${fox}`);
		}
	});

	test("lone high surrogate in message body sanitized safely", () => {
		const badInput = "Hello \ud800 body\nBest regards,\n[Your Name]";
		const res = parseDraftReplyParams({
			parameters: {
				messageId: "msg-123",
				body: badInput,
			},
		});
		expect("body" in res).toBe(true);
		if ("body" in res) {
			expect(isWellFormed(res.body)).toBe(true);
		}
	});

	test("sweep whitespace with emojis before signature remains well-formed", () => {
		const fox = "🦊";
		for (let spaces = 0; spaces < 5; spaces++) {
			const input = `Message ${" ".repeat(spaces)}${fox}\nThanks,\n[Your Name]`;
			const res = parseDraftReplyParams({
				parameters: {
					messageId: "msg-123",
					body: input,
				},
			});
			expect("body" in res).toBe(true);
			if ("body" in res) {
				expect(isWellFormed(res.body)).toBe(true);
			}
		}
	});
});
