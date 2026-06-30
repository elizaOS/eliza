import { describe, expect, it } from "vitest";
import {
	parseSecretSwapExemptValues,
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

	it("round-trips structured tool-call args losslessly at the execution boundary", () => {
		const session = new SecretSwapSession({
			knownSecrets: { WEBHOOK_SECRET: "whsec_1234567890abcdef" },
		});
		const toolArgs = {
			url: "https://api.example.com/hook",
			retries: 3,
			enabled: true,
			headers: { Authorization: "Bearer whsec_1234567890abcdef" },
			body: { token: "whsec_1234567890abcdef", note: "ping" },
		};

		const swapped = session.substituteInValue(toolArgs);

		// The model-visible args must never contain the raw secret.
		expect(JSON.stringify(swapped)).not.toContain("whsec_1234567890abcdef");
		expect(swapped.headers.Authorization).toBe("Bearer __ELIZA_SECRET_1__");
		expect(swapped.body.token).toBe("__ELIZA_SECRET_1__");
		// Non-string scalars pass through untouched.
		expect(swapped.retries).toBe(3);
		expect(swapped.enabled).toBe(true);

		// The execution boundary restores the exact original before the tool runs.
		const restored = session.restoreInValue(swapped, {
			failOnUnresolved: true,
		});
		expect(restored).toEqual(toolArgs);
	});

	it("fails loud at the boundary when the model fabricates an unknown placeholder", () => {
		const session = new SecretSwapSession({
			knownSecrets: { API_KEY: "sk-real_1234567890abcdef" },
		});
		const swapped = session.substituteInValue({
			cmd: "deploy sk-real_1234567890abcdef",
		});
		const tampered = { ...swapped, extra: "curl __ELIZA_SECRET_77__" };

		expect(() =>
			session.restoreInValue(tampered, { failOnUnresolved: true }),
		).toThrow(SecretSwapUnresolvedPlaceholderError);
		// Without fail-loud, a genuine placeholder still restores and the
		// fabricated one is left verbatim rather than invented.
		expect(session.restoreInValue(tampered)).toEqual({
			cmd: "deploy sk-real_1234567890abcdef",
			extra: "curl __ELIZA_SECRET_77__",
		});
	});

	it("asserts no unresolved placeholders leak into structured output", () => {
		const session = new SecretSwapSession({
			knownSecrets: { API_KEY: "sk-real_1234567890abcdef" },
		});

		// The constructor issues __ELIZA_SECRET_1__ for the known secret.
		expect(() =>
			session.assertNoUnresolvedPlaceholders({ a: "__ELIZA_SECRET_1__" }),
		).not.toThrow();

		try {
			session.assertNoUnresolvedPlaceholders({
				a: "__ELIZA_SECRET_1__",
				b: "use __ELIZA_SECRET_2__ now",
			});
			throw new Error("expected assertNoUnresolvedPlaceholders to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(SecretSwapUnresolvedPlaceholderError);
			expect(
				(error as SecretSwapUnresolvedPlaceholderError).placeholders,
			).toEqual(["__ELIZA_SECRET_2__"]);
		}
	});

	it("preserves exempt values while still swapping the rest", () => {
		const session = new SecretSwapSession({
			exemptValues: ["sk-exempt_1234567890"],
		});
		const swapped = session.substituteText(
			"public sk-exempt_1234567890 and secret sk-secret_1234567890",
		);

		expect(swapped).toContain("sk-exempt_1234567890");
		expect(swapped).not.toContain("sk-secret_1234567890");
		expect(session.entries).toHaveLength(1);
		expect(session.restoreText(swapped, { failOnUnresolved: true })).toBe(
			"public sk-exempt_1234567890 and secret sk-secret_1234567890",
		);
	});

	it("parses comma-separated exempt values and ignores blanks", () => {
		expect(parseSecretSwapExemptValues("alpha, beta ,, gamma ")).toEqual([
			"alpha",
			"beta",
			"gamma",
		]);
		expect(parseSecretSwapExemptValues(undefined)).toEqual([]);
		expect(parseSecretSwapExemptValues(42)).toEqual([]);
	});
});
