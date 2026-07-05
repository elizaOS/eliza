/**
 * Secret redaction is the last line stopping API keys / tokens / character
 * secrets from leaking into logs, tool output, or memories. Known secrets are
 * replaced wholesale by [REDACTED:name] (longest-first so one secret can't be
 * partially masked), and pattern detection masks common key shapes (sk-, ghp_,
 * Bearer, PEM) even when the value isn't in the known-secrets map. A full secret
 * value must never survive in the output.
 */

import { describe, expect, it } from "vitest";
import {
	createSecretsRedactor,
	getDefaultRedactPatterns,
	isSensitiveKeyName,
	redactLogArgs,
	redactObjectSecrets,
	redactSecrets,
	redactSensitiveText,
	redactWithSecrets,
} from "./redact.ts";

describe("redactSecrets (known values)", () => {
	it("replaces an exact secret with [REDACTED:name]", () => {
		const out = redactSecrets("token is supersecretvalue123 ok", {
			API_KEY: "supersecretvalue123",
		});
		expect(out).toBe("token is [REDACTED:API_KEY] ok");
		expect(out).not.toContain("supersecretvalue123");
	});

	it("ignores too-short secret values (<8 chars) to avoid false positives", () => {
		expect(redactSecrets("the word cat appears", { X: "cat" })).toBe(
			"the word cat appears",
		);
	});

	it("masks the longer secret first when one contains another", () => {
		const out = redactSecrets("value: abcdefgh12345", {
			SHORT: "abcdefgh",
			LONG: "abcdefgh12345",
		});
		expect(out).toContain("[REDACTED:LONG]");
		expect(out).not.toContain("abcdefgh12345");
	});
});

describe("redactSensitiveText (pattern detection)", () => {
	it("masks an openai-style key without leaking it", () => {
		const key = "sk-0123456789abcdefghij";
		const out = redactSensitiveText(`my key ${key} end`);
		expect(out).not.toContain(key);
		expect(out).toContain("…");
	});

	it("masks a Cerebras inference key (csk-) without leaking it or eating the sk- variant", () => {
		// csk- is a distinct prefix from OpenAI's sk-; sub-agent stdout echoes it as
		// the model key in use (#13775 review). The word boundary must not let the
		// sk- pattern partial-match inside csk-.
		const csk = "csk-0123456789abcdefghij";
		const out = redactSensitiveText(`model key ${csk} end`);
		expect(out).not.toContain(csk);
		expect(out).toContain("…");
	});

	it("masks a GitHub PAT and a Bearer token", () => {
		const ghp = `ghp_${"a".repeat(30)}`;
		expect(redactSensitiveText(`use ${ghp}`)).not.toContain(ghp);
		const bearer = `Bearer ${"a".repeat(40)}`;
		expect(redactSensitiveText(bearer)).not.toContain("a".repeat(40));
	});

	it("masks Stripe secret + restricted keys (underscore form)", () => {
		// Stripe is the payment processor — a leaked sk_live_ is catastrophic, and these
		// often appear as bare values (not under a *_SECRET name) in logged request bodies.
		// Assemble the token from fragments at runtime so a contiguous Stripe-shaped key
		// never sits in source — GitHub push-protection blocks even a fake literal one.
		const body = "0123456789abcdefghijABCDEF";
		for (const prefix of ["sk_live_", "sk_test_", "rk_live_", "rk_test_"]) {
			const key = `${prefix}${body}`;
			const out = redactSensitiveText(`stripe key ${key} end`);
			expect(out).not.toContain(key);
			expect(out).toContain("…");
		}
	});

	it("mode:off is a passthrough", () => {
		const key = "sk-0123456789abcdefghij";
		expect(redactSensitiveText(key, { mode: "off" })).toBe(key);
	});
});

describe("getDefaultRedactPatterns", () => {
	it("returns a non-empty copy", () => {
		const a = getDefaultRedactPatterns();
		expect(a.length).toBeGreaterThan(0);
		a.push("mutation");
		expect(getDefaultRedactPatterns()).not.toContain("mutation"); // copy, not reference
	});
});

describe("redactWithSecrets / createSecretsRedactor / redactObjectSecrets", () => {
	const secrets = { TOKEN: "knownsecret12345" };

	it("redactWithSecrets combines known secrets + patterns", () => {
		const out = redactWithSecrets(
			"knownsecret12345 and sk-0123456789abcdefghij",
			{
				secrets,
			},
		);
		expect(out).toContain("[REDACTED:TOKEN]");
		expect(out).not.toContain("sk-0123456789abcdefghij");
	});

	it("createSecretsRedactor binds the secrets", () => {
		const redact = createSecretsRedactor(secrets);
		expect(redact("has knownsecret12345 here")).toContain("[REDACTED:TOKEN]");
	});

	it("redactObjectSecrets walks nested strings", () => {
		const out = redactObjectSecrets(
			{ a: "knownsecret12345", nested: { b: ["knownsecret12345"] } },
			secrets,
		);
		expect(out.a).toBe("[REDACTED:TOKEN]");
		expect((out.nested.b as string[])[0]).toBe("[REDACTED:TOKEN]");
	});
});

describe("replacement-pattern safety ($-expansion)", () => {
	it("does not re-expand $& in a masked token back into the full secret", () => {
		// The kept prefix of the mask ("ab$&cd") contains `$&`; a string
		// replacement would expand it to the whole matched token, leaking the
		// full secret into the "redacted" output.
		const secret = "ab$&cdefghijklmnopqrs";
		const out = redactSensitiveText(`PASSWORD=${secret}`);
		expect(out).not.toContain(secret);
		expect(out).toBe("PASSWORD=ab$&cd…pqrs");
	});

	it("does not expand $' in a masked token into the trailing text", () => {
		const secret = "xy$'zabcdefghijklmnop";
		const out = redactSensitiveText(`API_KEY=${secret} trailing`);
		expect(out).not.toContain(secret);
	});

	it("inserts a secret name containing $& literally in redactSecrets", () => {
		const out = redactSecrets("value is supersecretvalue123", {
			"WEIRD$&NAME": "supersecretvalue123",
		});
		expect(out).toBe("value is [REDACTED:WEIRD$&NAME]");
		expect(out).not.toContain("supersecretvalue123");
	});
});

/**
 * Name-based key detection (isSensitiveKeyName) is the single source of truth
 * shared by the cloud logger's redact.context and the log-sink redactor, so
 * "which field names are secret" is defined once (#12229 M6).
 */
describe("isSensitiveKeyName", () => {
	it("flags credential-named keys regardless of case/separator", () => {
		for (const key of [
			"apiKey",
			"api_key",
			"password",
			"secret",
			"privateKey",
			"private_key",
			"accessToken",
			"refreshToken",
			"authorization",
			"mnemonic",
			"seedPhrase",
			"sshKey",
			"signingKey",
			"credential",
		]) {
			expect(isSensitiveKeyName(key)).toBe(true);
		}
	});

	it("does not flag benign keys, including tokenId", () => {
		for (const key of ["userId", "count", "tokenId", "name", "url", "status"]) {
			expect(isSensitiveKeyName(key)).toBe(false);
		}
	});
});

/**
 * redactLogArgs is the sink-level redactor: it masks secrets structurally so a
 * logger that pipes its args through it protects `{ apiKey }` with no
 * redact.context() at the call site (#12229 M6).
 */
describe("redactLogArgs (log-sink redaction, not opt-in)", () => {
	it("masks a value under a credential-named key without any wrapping", () => {
		const [msg, ctx] = redactLogArgs([
			"boot",
			{ apiKey: "eliza_supersecretvalue123456", userId: "u-1" },
		]) as [string, Record<string, unknown>];
		expect(msg).toBe("boot");
		expect(ctx.apiKey).toBe("[REDACTED]");
		expect(ctx.userId).toBe("u-1");
		expect(JSON.stringify(ctx)).not.toContain("eliza_supersecretvalue123456");
	});

	it("masks a value-shaped secret in a plain string argument", () => {
		const [msg] = redactLogArgs(["key is sk-abcdefghijklmnop1234"]) as [string];
		expect(msg).not.toContain("sk-abcdefghijklmnop1234");
	});

	it("masks a nested credential-named key", () => {
		const [ctx] = redactLogArgs([
			{ config: { db: { password: "hunter2-supersecret" } } },
		]) as [Record<string, unknown>];
		expect(JSON.stringify(ctx)).not.toContain("hunter2-supersecret");
		expect(JSON.stringify(ctx)).toContain("[REDACTED]");
	});

	it("masks the whole value under a credential-named key, even when it is not a string", () => {
		const [ctx] = redactLogArgs([
			{
				authorization: {
					scheme: "Bearer",
					value: "nested-supersecret-value",
				},
			},
		]) as [Record<string, unknown>];
		expect(ctx.authorization).toBe("[REDACTED]");
		expect(JSON.stringify(ctx)).not.toContain("nested-supersecret-value");
	});

	it("scrubs a secret interpolated into an Error message", () => {
		const [err] = redactLogArgs([
			new Error("failed with token=sk-abcdefghijklmnop1234"),
		]) as [Error];
		expect(err).toBeInstanceOf(Error);
		expect(err.message).not.toContain("sk-abcdefghijklmnop1234");
	});

	it("does not hang or throw on a cyclic object", () => {
		const cyclic: Record<string, unknown> = { name: "x" };
		cyclic.self = cyclic;
		const [out] = redactLogArgs([cyclic]) as [Record<string, unknown>];
		expect(out.name).toBe("x");
	});

	it("leaves non-string, non-object arguments untouched", () => {
		expect(redactLogArgs([1, true, null, undefined])).toEqual([
			1,
			true,
			null,
			undefined,
		]);
	});
});
