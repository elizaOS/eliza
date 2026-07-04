/**
 * Covers the extended secret classes in `detectPii` and their validators —
 * BIP-39 mnemonics, WIF keys, URL credentials, provider tokens (Anthropic,
 * Stripe, Slack, Telegram, Google OAuth), PGP/OpenSSH key blocks — plus the
 * registry/config-derived secret seeding (`isSecretKey`, `deriveKnownSecrets`).
 * Deterministic string checks, no external calls.
 */

import { describe, expect, it } from "vitest";
import { deriveKnownSecrets, isSecretKey } from "../constants/secrets";
import { findMnemonicPhrase, mnemonicValid } from "./bip39-wordlist";
import { detectPii, wifValid } from "./pii-detectors";

function kinds(text: string): string[] {
	return detectPii(text).map((m) => m.kind);
}
function valueForKind(text: string, kind: string): string | undefined {
	return detectPii(text).find((m) => m.kind === kind)?.value;
}

const VALID_MNEMONIC =
	"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("validators — mnemonic + WIF", () => {
	it("mnemonicValid accepts real mnemonics, rejects bad checksums + sentences", () => {
		expect(mnemonicValid(VALID_MNEMONIC)).toBe(true);
		expect(
			mnemonicValid(
				"legal winner thank year wave sausage worth useful legal winner thank yellow",
			),
		).toBe(true);
		expect(
			mnemonicValid("zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo"),
		).toBe(false);
		expect(
			mnemonicValid(
				"the quick brown fox jumps over lazy dogs runs home now then",
			),
		).toBe(false);
		expect(mnemonicValid("abandon about")).toBe(false);
	});

	it("findMnemonicPhrase extracts the exact window from surrounding text", () => {
		expect(findMnemonicPhrase(`seed: ${VALID_MNEMONIC}. keep safe`)).toBe(
			VALID_MNEMONIC,
		);
		expect(
			findMnemonicPhrase(
				"abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon longword about",
			),
		).toBeNull();
	});

	it("wifValid base58check-validates Bitcoin WIF keys", () => {
		expect(
			wifValid("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ"),
		).toBe(true);
		expect(
			wifValid("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn"),
		).toBe(true);
		expect(
			wifValid("5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTX"),
		).toBe(false);
		expect(wifValid("QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG")).toBe(
			false,
		);
	});
});

describe("detectPii — issue-named secret classes", () => {
	it("BIP-39 seed phrase", () => {
		expect(
			valueForKind(`recovery ${VALID_MNEMONIC} stored`, "seed-phrase"),
		).toBe(VALID_MNEMONIC);
		expect(
			kinds("the quick brown fox jumps over lazy dogs run now then here"),
		).not.toContain("seed-phrase");
	});
	it("WIF wallet private key", () => {
		expect(
			kinds("key 5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ"),
		).toContain("wif-private-key");
	});
	it("DB connection string with password (swaps whole credential)", () => {
		expect(
			valueForKind(
				"DB=postgres://app:s3cr3tP4ss@db.host:5432/prod",
				"url-credentials",
			),
		).toBe("postgres://app:s3cr3tP4ss@db.host:5432/prod");
		expect(kinds("redis://localhost:6379/0")).not.toContain("url-credentials");
	});
	it("account password inside an https URL", () => {
		expect(kinds("https://admin:hunter2hunter2@host.example.com/x")).toContain(
			"url-credentials",
		);
	});
	it("Anthropic key labelled distinctly (not openai-key)", () => {
		const ks = kinds("sk-ant-api03-9fK3xQ7zL2mNpR8tV4wYbC1dE6gH0jKlMnOp");
		expect(ks).toContain("anthropic-key");
		expect(ks).not.toContain("openai-key");
	});
	it("Stripe webhook secret + Slack webhook url", () => {
		expect(kinds("whsec_aBcD1234efGH5678ijKL9012mnOPqrSt")).toContain(
			"stripe-webhook-secret",
		);
		expect(
			kinds(
				"https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX",
			),
		).toContain("slack-webhook-url");
	});
	it("Basic-auth header (base64 user:pass) + Google OAuth refresh token", () => {
		expect(
			valueForKind(
				"Authorization: Basic dXNlcjpzM2NyZXRwYXNz",
				"basic-auth-header",
			),
		).toBe("dXNlcjpzM2NyZXRwYXNz");
		expect(kinds("Authorization: Basic YWJjZGVmZ2hpamts")).not.toContain(
			"basic-auth-header",
		);
		expect(
			kinds("token 1//0gB7xLm9Qw3rT4refreshTokenBodyAbCdEf0123456789"),
		).toContain("google-oauth-refresh-token");
	});
	it("Telegram bot token + PGP private key block", () => {
		expect(kinds("123456789:AAH-abcdefghijklmnopqrstuvwxyz1234567")).toContain(
			"telegram-bot-token",
		);
		const pgp =
			"-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBF...\n-----END PGP PRIVATE KEY BLOCK-----";
		expect(valueForKind(pgp, "pgp-private-key")).toBe(pgp);
	});
	it("OpenSSH private key block is covered by the PEM detector", () => {
		const key =
			"-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1r\n-----END OPENSSH PRIVATE KEY-----";
		expect(kinds(key)).toContain("private-key");
	});
});

describe("catalog — registry/config-derived secret seeding", () => {
	it("isSecretKey recognises canonical + open-ended secret field names", () => {
		for (const k of [
			"OPENAI_API_KEY",
			"FOO_TOKEN",
			"DB_PASSWORD",
			"WALLET_MNEMONIC",
			"X_SECRET",
			"STRIPE_WEBHOOK_SECRET",
			"SOLANA_PRIVATE_KEY",
			"MY_CREDENTIAL",
		]) {
			expect(isSecretKey(k)).toBe(true);
		}
		for (const k of ["PATH", "NODE_ENV", "PORT", "LOG_LEVEL", "HOME", ""]) {
			expect(isSecretKey(k)).toBe(false);
		}
	});
	it("deriveKnownSecrets keeps only secret-named non-empty values", () => {
		expect(
			deriveKnownSecrets({
				OPENAI_API_KEY: "sk-real-value-123",
				FOO_TOKEN: "tok_abc",
				PATH: "/usr/bin",
				NODE_ENV: "production",
				EMPTY_SECRET: "",
				DB_PASSWORD: "p@ss",
			}),
		).toEqual({
			OPENAI_API_KEY: "sk-real-value-123",
			FOO_TOKEN: "tok_abc",
			DB_PASSWORD: "p@ss",
		});
	});
	it("deriveKnownSecrets skips weak all-lowercase dictionary defaults, keeps real opaque secrets", () => {
		// A secret-named env var whose value is a bare dictionary word (a common
		// default like `password`/`changeme`) must NOT be auto-seeded — swapping it
		// verbatim would corrupt legitimate text that merely contains that word.
		// Real opaque secrets (digits/case/symbols/spaces) are still seeded.
		expect(
			deriveKnownSecrets({
				ADMIN_PASSWORD: "password",
				LOGIN_SECRET: "changeme",
				API_KEY: "sk-Ab3xK9zPmq",
				WALLET_MNEMONIC: "legal winner thank year",
			}),
		).toEqual({
			API_KEY: "sk-Ab3xK9zPmq",
			WALLET_MNEMONIC: "legal winner thank year",
		});
	});
});
