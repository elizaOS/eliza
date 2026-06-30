import { describe, expect, it } from "vitest";
import {
	SecretSwapSession,
	SecretSwapUnresolvedPlaceholderError,
} from "./secret-swap";

describe("SecretSwapSession", () => {
	it("substitutes detected secrets and restores them at the execution boundary", () => {
		const session = new SecretSwapSession();
		const swapped = session.substituteText(
			"Use OPENAI_API_KEY=sk-test_1234567890abcdef and email ops@example.com.",
		);

		expect(swapped).toBe(
			"Use OPENAI_API_KEY=__ELIZA_SECRET_1__ and email __ELIZA_SECRET_2__.",
		);
		expect(swapped).not.toContain("sk-test_1234567890abcdef");
		expect(swapped).not.toContain("ops@example.com");
		expect(session.restoreText(swapped, { failOnUnresolved: true })).toBe(
			"Use OPENAI_API_KEY=sk-test_1234567890abcdef and email ops@example.com.",
		);
	});

	it("keeps placeholders deterministic for repeated values in structured params", () => {
		const session = new SecretSwapSession({
			knownSecrets: { apiKey: "sk-known_1234567890abcdef" },
		});
		const swapped = session.substituteInValue({
			prompt: "key sk-known_1234567890abcdef",
			messages: [{ role: "user", content: "sk-known_1234567890abcdef" }],
		});

		expect(swapped).toEqual({
			prompt: "key __ELIZA_SECRET_1__",
			messages: [{ role: "user", content: "__ELIZA_SECRET_1__" }],
		});
		expect(session.entries).toHaveLength(1);
	});

	it("fails loud when a placeholder cannot be resolved", () => {
		const session = new SecretSwapSession();

		expect(() =>
			session.restoreText("curl -H __ELIZA_SECRET_99__", {
				failOnUnresolved: true,
			}),
		).toThrow(SecretSwapUnresolvedPlaceholderError);
	});
});
