import { expect, test } from "vitest";
import { GuardedStreamScanner } from "../security/guarded-stream";
import { SecretSwapSession } from "../security/secret-swap";

const value = "synthetic-credential-abc123456789";
test("lowercase and mixed-case assignments redact model input and user reply", () => {
	for (const key of ["password", "api_key", "access_token", "PaSsWoRd"]) {
		const s = new SecretSwapSession(),
			text = `${key}=${value}`,
			wire = s.substituteText(text);
		expect(wire).not.toContain(value);
		expect(s.restoreUserReplyText(wire)).not.toContain(value);
		expect(s.restoreText(wire)).toBe(text);
	}
});
test("lowercase credential assignment protects a previously recognized email", () => {
	const s = new SecretSwapSession(),
		email = "synthetic.contact@example.invalid",
		first = s.substituteText(email);
	s.substituteText("password=" + email);
	expect(s.restoreUserReplyText(first)).toBe("[redacted credential]");
});
test("all stream splits protect lowercase assignments including whitespace around equals", () => {
	for (const key of ["password", "api_key", "access_token"])
		for (const gap of ["=", " = "]) {
			const text = `${key}${gap}${value} end`;
			for (let split = 1; split < text.length; split++) {
				const s = new SecretSwapSession(),
					scanner = new GuardedStreamScanner({ secretSession: s }),
					out = [
						scanner.push("Context. ".repeat(100) + text.slice(0, split)),
						scanner.push(text.slice(split)),
						scanner.flush(),
					];
				expect(out.map((x) => x.safe).join("")).not.toContain(value);
				expect(out.map((x) => x.visible).join("")).not.toContain(value);
			}
		}
});

import { redactSensitiveLogText } from "../security/log-redaction";

test("log text uses the same assignment protection without matching ordinary lowercase suffixes", () => {
	expect(redactSensitiveLogText("password=" + value)).not.toContain(value);
	for (const key of ["monkey", "donkey", "turnkey"]) {
		const text = key + "=" + value;
		expect(new SecretSwapSession().substituteText(text)).toBe(text);
	}
});
test("prefixed lowercase credential names redact logs and model input", () => {
	for (const key of [
		"db_password",
		"openai_api_key",
		"github_token",
		"aws_secret_access_key",
		"oauth-client-secret",
	]) {
		const text = `${key}=${value}`;
		expect(redactSensitiveLogText(text)).not.toContain(value);
		const s = new SecretSwapSession(),
			wire = s.substituteText(text);
		expect(wire).not.toContain(value);
		expect(s.restoreText(wire)).toBe(text);
	}
	// A separator is required, so ordinary words and plural fields still pass.
	for (const key of [
		"monkey",
		"turnkey_mode",
		"keyboard_layout",
		"max_tokens",
	]) {
		const text = `${key}=${value}`;
		expect(new SecretSwapSession().substituteText(text)).toBe(text);
		expect(redactSensitiveLogText(text)).toBe(text);
	}
});
test("stream retains every named assignment opener before an unknown long credential", () => {
	for (const key of [
		"db_password",
		"github_token",
		"aws_secret_access_key",
		"password",
		"passwd",
		"passphrase",
		"mnemonic",
		"seed",
		"credential",
		"secret",
		"token",
		"api-key",
		"api_key",
		"access-token",
		"refresh-token",
		"auth-token",
		"bot-token",
		"session-key",
		"private-key",
		"client-secret",
		"seed-phrase",
		"seed_phrase",
		"seedphrase",
	]) {
		const secret = "synthetic-credential-" + "a1b2c3".repeat(100),
			s = new SecretSwapSession(),
			scanner = new GuardedStreamScanner({ secretSession: s });
		const parts = [
			scanner.push(
				"Context. ".repeat(100) + key + " = " + secret.slice(0, 300),
			),
			scanner.push(secret.slice(300) + " end"),
			scanner.flush(),
		];
		expect(parts.map((p) => p.safe).join("")).not.toContain(secret);
		expect(parts.map((p) => p.visible).join("")).not.toContain(secret);
	}
});
