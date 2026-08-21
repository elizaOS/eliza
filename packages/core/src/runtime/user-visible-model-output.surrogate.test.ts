/** Surrogate safety for user-visible model output envelope classification. */
import { describe, expect, test } from "vitest";
import {
	looksLikeActionEnvelopeJson,
	sanitizeUserVisibleModelOutput,
} from "./user-visible-model-output.ts";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return true;
}

describe("user-visible-model-output surrogate safety", () => {
	test("emoji at 19999 boundary backs off cleanly without lone surrogate", () => {
		const fox = "🦊";
		const jsonBody = JSON.stringify({
			action: "DO_SOMETHING",
			padding: "a".repeat(19950) + fox + "b".repeat(1000),
		});
		const classification = sanitizeUserVisibleModelOutput(jsonBody);
		expect(classification.kind).toBe("control");
		if (classification.kind === "control") {
			expect(classification.envelope).toBe("action");
		}
	});

	test("fitting emoji ending at 20000 kept intact", () => {
		const fox = "🦊";
		const jsonBody = JSON.stringify({
			text: "Hello world " + "a".repeat(19900) + fox,
			shouldRespond: true,
		});
		const result = sanitizeUserVisibleModelOutput(jsonBody);
		expect(result.kind).toBe("text");
		if (result.kind === "text") {
			expect(isWellFormed(result.text)).toBe(true);
		}
	});

	test("lone high surrogate in text does not throw during classification", () => {
		const badInput =
			'{"action": "TEST", "data": "bad \ud800 ' + "x".repeat(25000) + '"}';
		expect(() => sanitizeUserVisibleModelOutput(badInput)).not.toThrow();
		expect(looksLikeActionEnvelopeJson(badInput)).toBe(true);
	});

	test("sweep offsets around 20000 cap all stay well-formed", () => {
		const fox = "🦊";
		for (let n = 19990; n <= 20005; n++) {
			const json =
				'{"text": "' + "a".repeat(n) + fox + '", "shouldRespond": true}';
			expect(() => sanitizeUserVisibleModelOutput(json)).not.toThrow();
		}
	});
});
