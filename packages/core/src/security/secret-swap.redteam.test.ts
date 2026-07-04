/**
 * Adversarial / red-team suite for the secret-swap layer (#10469). These are the
 * cases an attacker (or a confused model) would use to either leak a real secret
 * or hijack the restore step. The layer's job is to FAIL LOUD or keep the
 * placeholder, never to silently leak.
 */
import { describe, expect, it } from "vitest";
import {
	SecretSwapSession,
	SecretSwapUnresolvedPlaceholderError,
} from "./secret-swap";

describe("secret-swap red-team", () => {
	const PLACEHOLDER_RE = /__ELIZA_SECRET_[0-9a-f]{8,}_\d+__/;
	const secret = "sk-live_redteam_AbC123dEf456GhI789";

	it("a FORGED placeholder never resolves to a real secret (unforgeable nonce)", () => {
		const session = new SecretSwapSession();
		const swapped = session.substituteText(`key ${secret}`); // real nonce'd placeholder
		const nonce = swapped.match(/__ELIZA_SECRET_([0-9a-f]+)_\d+__/)?.[1];
		expect(nonce).toBeTruthy();

		// Wrong/legacy nonce: not this session's — benign text, never resolves to
		// the secret, and (correctly) not treated as our unresolved placeholder.
		for (const forged of [
			"__ELIZA_SECRET_1__",
			"__ELIZA_SECRET_0000000000000000_1__",
			"__ELIZA_SECRET_deadbeefdeadbeef_99__",
		]) {
			expect(session.restoreText(`run ${forged}`)).not.toContain(secret);
			expect(
				session.restoreText(`run ${forged}`, { failOnUnresolved: true }),
			).toBe(`run ${forged}`); // benign, left as-is
		}

		// A this-session placeholder the model FABRICATED (right nonce, wrong N)
		// must fail loud — it cannot silently reach a real endpoint.
		expect(() =>
			session.restoreText(`run __ELIZA_SECRET_${nonce}_424242__`, {
				failOnUnresolved: true,
			}),
		).toThrow(SecretSwapUnresolvedPlaceholderError);
	});

	it("an attacker cannot make their forged placeholder map to a real secret", () => {
		// Even if the input text already contains a placeholder-shaped token, the
		// real secret gets a DIFFERENT (nonce'd, higher-N) placeholder — no collision.
		const session = new SecretSwapSession();
		const swapped = session.substituteText(
			`benign __ELIZA_SECRET_1__ and real ${secret}`,
		);
		const real = swapped.match(PLACEHOLDER_RE);
		expect(real).not.toBeNull();
		expect(real?.[0]).not.toBe("__ELIZA_SECRET_1__");
		// The benign legacy token is untouched; only the real secret was swapped.
		expect(swapped).toContain("__ELIZA_SECRET_1__");
		expect(swapped).not.toContain(secret);
		expect(session.restoreText(swapped, { failOnUnresolved: false })).toBe(
			`benign __ELIZA_SECRET_1__ and real ${secret}`,
		);
	});

	it("re-substitutes a raw secret the model reintroduced in its output (egress guard)", () => {
		const session = new SecretSwapSession({
			knownSecrets: { OPENAI_API_KEY: secret },
		});
		// Model "helpfully" echoes the raw secret back into its response.
		const modelOutput = `Sure — your key is ${secret}, all set!`;
		const guarded = session.substituteText(modelOutput);
		expect(guarded).not.toContain(secret);
		expect(guarded).toMatch(PLACEHOLDER_RE);
	});

	it("swaps + restores a secret buried deep in nested structures", () => {
		const session = new SecretSwapSession();
		const payload = {
			a: [{ b: { c: [`token ${secret}`, "benign"] } }],
			d: { e: { f: { g: secret } } },
		};
		const swapped = session.substituteInValue(payload);
		expect(JSON.stringify(swapped)).not.toContain(secret);
		// Same secret in two places → one deterministic placeholder.
		expect(session.entries).toHaveLength(1);
		expect(session.restoreInValue(swapped, { failOnUnresolved: true })).toEqual(
			payload,
		);
	});

	it("round-trips a secret value that literally contains placeholder-shaped text", () => {
		const session = new SecretSwapSession();
		const tricky = "AKIA__ELIZA_SECRET_1__ABCDXYZ";
		const swapped = session.substituteText(`key ${tricky}`);
		expect(session.restoreText(swapped, { failOnUnresolved: true })).toBe(
			`key ${tricky}`,
		);
	});

	it("respects per-value opt-out (exemptValues) and per-class opt-out (disabledKinds)", () => {
		const exemptSecret = "sk-live_exempt_AbC123dEf456GhI789";
		const session = new SecretSwapSession({
			exemptValues: [exemptSecret],
			disabledKinds: ["email"],
		});
		const swapped = session.substituteText(
			`exempt ${exemptSecret} email a@b.com other ${secret}`,
		);
		expect(swapped).toContain(exemptSecret); // opted out by value
		expect(swapped).toContain("a@b.com"); // class disabled
		expect(swapped).not.toContain(secret); // still swapped
	});

	it("keeps overlapping / substring secrets correct (longest-first)", () => {
		const long = "sk-live_AAAAAAAAAAAAAAAAAAAA_suffix_BBBB";
		const short = "sk-live_AAAAAAAAAAAAAAAAAAAA";
		const session = new SecretSwapSession({
			knownSecrets: { long, short },
		});
		const swapped = session.substituteText(`a ${long} b ${short} c`);
		expect(swapped).not.toContain(long);
		expect(session.restoreText(swapped, { failOnUnresolved: true })).toBe(
			`a ${long} b ${short} c`,
		);
	});

	it("documents the split-secret limitation: a contiguous secret is swapped, a split one is not (must be caught at the field boundary)", () => {
		const session = new SecretSwapSession();
		// Contiguous → swapped.
		expect(session.substituteText(secret)).not.toContain(secret);
		// Split across two fields → each half is too short / not a known shape, so
		// it is NOT swapped. This is why known character secrets are seeded into the
		// session (knownSecrets) — pattern detection alone cannot reassemble a
		// secret the user deliberately split. Asserting the boundary explicitly.
		// Halves chosen so neither is independently a known secret/PII shape
		// (a full 16-digit card split into two 8-digit groups).
		const half1 = "4242 4242";
		const half2 = "4242 4242";
		const swapped = session.substituteInValue({ a: half1, b: half2 });
		expect(swapped).toEqual({ a: half1, b: half2 });
	});

	it("assertNoUnresolvedPlaceholders throws on a fabricated this-session placeholder in a structure", () => {
		const session = new SecretSwapSession();
		const swapped = session.substituteText(`key ${secret}`);
		const nonce = swapped.match(/__ELIZA_SECRET_([0-9a-f]+)_\d+__/)?.[1];
		expect(() =>
			session.assertNoUnresolvedPlaceholders({
				cmd: ["curl", "-H", `Authorization: __ELIZA_SECRET_${nonce}_777__`],
			}),
		).toThrow(SecretSwapUnresolvedPlaceholderError);
		// A foreign/legacy placeholder-shaped string does not trip the guard.
		expect(() =>
			session.assertNoUnresolvedPlaceholders({
				cmd: ["echo", "__ELIZA_SECRET_1__"],
			}),
		).not.toThrow();
	});

	it("restore of clean text is identity and asserts cleanly", () => {
		const session = new SecretSwapSession();
		const text = "just a normal sentence with no secrets at all";
		expect(session.restoreText(text, { failOnUnresolved: true })).toBe(text);
		expect(() => session.assertNoUnresolvedPlaceholders(text)).not.toThrow();
	});
});
