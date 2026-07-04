/**
 * Core unit tests for {@link SecretSwapSession}: substitute/restore round-trip,
 * deterministic placeholders for repeated values, and fail-loud on a fabricated
 * this-session placeholder. Deterministic and in-process — no model, no DB.
 */
import { describe, expect, it } from "vitest";
import {
	SecretSwapSession,
	SecretSwapUnresolvedPlaceholderError,
} from "./secret-swap";

describe("SecretSwapSession", () => {
	const PLACEHOLDER = /__ELIZA_SECRET_[0-9a-f]{8,}_\d+__/;

	it("substitutes detected secrets and restores them at the execution boundary", () => {
		const session = new SecretSwapSession();
		const original =
			"Use OPENAI_API_KEY=sk-test_1234567890abcdef and email ops@example.com.";
		const swapped = session.substituteText(original);

		// Two nonce'd placeholders, no raw secret in the swapped (model-facing) text.
		expect(swapped.match(/__ELIZA_SECRET_[0-9a-f]{8,}_\d+__/g)).toHaveLength(2);
		expect(swapped).not.toContain("sk-test_1234567890abcdef");
		expect(swapped).not.toContain("ops@example.com");
		// Round-trip restores the exact original at the execution boundary.
		expect(session.restoreText(swapped, { failOnUnresolved: true })).toBe(
			original,
		);
	});

	it("keeps placeholders deterministic for repeated values in structured params", () => {
		const session = new SecretSwapSession({
			knownSecrets: { apiKey: "sk-known_1234567890abcdef" },
		});
		const swapped = session.substituteInValue({
			prompt: "key sk-known_1234567890abcdef",
			messages: [{ role: "user", content: "sk-known_1234567890abcdef" }],
		}) as { prompt: string; messages: { role: string; content: string }[] };

		// Same secret → same placeholder everywhere; one entry total.
		expect(swapped.prompt).toMatch(PLACEHOLDER);
		const placeholder = swapped.prompt.replace("key ", "");
		expect(swapped.messages[0]?.content).toBe(placeholder);
		expect(session.entries).toHaveLength(1);
		expect(swapped.prompt).not.toContain("sk-known");
	});

	it("fails loud on a fabricated this-session placeholder, ignores foreign ones", () => {
		const session = new SecretSwapSession();
		const swapped = session.substituteText("key sk-test_1234567890abcdef");
		const nonce = swapped.match(/__ELIZA_SECRET_([0-9a-f]+)_\d+__/)?.[1];
		expect(nonce).toBeTruthy();

		// A this-session-format placeholder the layer never minted (a model that
		// fabricated `…_99__`) must fail loud rather than reach a real endpoint.
		expect(() =>
			session.restoreText(`curl -H __ELIZA_SECRET_${nonce}_99__`, {
				failOnUnresolved: true,
			}),
		).toThrow(SecretSwapUnresolvedPlaceholderError);

		// A legacy / foreign placeholder-shaped string was never minted with this
		// nonce — it cannot reference a real secret, so it is benign text, left
		// as-is (no false-positive failure).
		expect(
			session.restoreText("curl -H __ELIZA_SECRET_99__", {
				failOnUnresolved: true,
			}),
		).toBe("curl -H __ELIZA_SECRET_99__");
	});
});
