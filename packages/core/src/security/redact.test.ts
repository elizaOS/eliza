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
	it("redacts credentials embedded in URI userinfo", () => {
		const httpsUrl = "https://admin:hunter2hunter2@host.example.com/private";
		const postgresUrl =
			"postgres://service:database-password-123@db.example.com:5432/app";
		const tokenUrl =
			"https://github-token-value-123456789@github.com/org/repo.git";
		const passwordOnlyUrl =
			"https://:password-only-value-123456789@host.example/db";

		const redactedHttps = redactSensitiveText(httpsUrl);
		const redactedPostgres = redactSensitiveText(postgresUrl);
		const redactedToken = redactSensitiveText(tokenUrl);
		const redactedPasswordOnly = redactSensitiveText(passwordOnlyUrl);

		expect(redactedHttps).toContain("https://");
		expect(redactedHttps).toContain("@host.example.com/private");
		expect(redactedHttps).not.toContain("admin");
		expect(redactedHttps).not.toContain("hunter2hunter2");
		expect(redactedPostgres).toContain("postgres://");
		expect(redactedPostgres).toContain("@db.example.com:5432/app");
		expect(redactedPostgres).not.toContain("service");
		expect(redactedPostgres).not.toContain("database-password-123");
		expect(redactedToken).toContain("@github.com/org/repo.git");
		expect(redactedToken).not.toContain("github-token-value-123456789");
		expect(redactedPasswordOnly).toContain("@host.example/db");
		expect(redactedPasswordOnly).not.toContain("password-only-value-123456789");
	});

	it("rewrites the userinfo span, never the scheme, for short user names", () => {
		// A first-occurrence `replace(userinfo, "***")` matches inside the scheme
		// whenever the userinfo is a substring of it: "https://s@host/x" became
		// "http***://s@host/x", leaving the credential fully intact.
		const shortUser = redactSensitiveText("https://s@host/x");
		expect(shortUser).toBe("https://***@host/x");
		expect(shortUser).toContain("https://");

		const postgres = redactSensitiveText("postgres://p@db");
		expect(postgres).toBe("postgres://***@db");
		expect(postgres).toContain("postgres://");
	});

	it("masks the leading userinfo of a password containing a literal @", () => {
		// Documented residual: the userinfo class cannot cross an `@`, so only the
		// span up to the first `@` is masked. The scheme must still survive intact
		// and the leading credential must be gone.
		const out = redactSensitiveText("https://user:p@ss@host/db");
		expect(out).toContain("https://");
		expect(out).not.toContain("user:p");
		expect(out.startsWith("https://***@")).toBe(true);
	});

	it("redacts both spaced and equals-form credential flags", () => {
		const spaced = "run --token flag-secret-value-123456789";
		const equals = "run --password=flag-password-value-123456789";

		expect(redactSensitiveText(spaced)).not.toContain(
			"flag-secret-value-123456789",
		);
		expect(redactSensitiveText(equals)).not.toContain(
			"flag-password-value-123456789",
		);
	});

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

	it("masks an Authorization credential for any scheme, not just Bearer", () => {
		// RFC 7235 leaves the scheme set open, so keying on `Bearer` alone left
		// `Basic <base64 user:password>` — a complete reusable credential, and the
		// exact thing a relayed `curl -v` trace prints — in plaintext.
		const basic = "dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk";
		const out = redactSensitiveText(`> Authorization: Basic ${basic}`);
		expect(out).not.toContain(basic);
		expect(out).toContain("Authorization: Basic ");

		// Scheme-less and proxy forms carry the same credential.
		expect(redactSensitiveText(`Authorization: ${basic}`)).not.toContain(basic);
		expect(
			redactSensitiveText(`Proxy-Authorization: Basic ${basic}`),
		).not.toContain(basic);
	});

	it("still masks env-style *_AUTHORIZATION names", () => {
		// `_` is a word character, so left-anchoring the header rule with `\b`
		// silently stops matching the `SERVICE_AUTHORIZATION=Bearer …` form an
		// `env` dump prints. The generalized rule must stay a strict superset.
		expect(
			redactSensitiveText("VOICE_REALTIME_ELIZA_AUTHORIZATION: Bearer service"),
		).toBe("VOICE_REALTIME_ELIZA_AUTHORIZATION: Bearer ***");
		expect(
			redactSensitiveText(
				"ELIZA_AUTHORIZATION: Basic dXNlcjpzdXBlcnNlY3JldA==",
			),
		).not.toContain("dXNlcjpzdXBlcnNlY3JldA==");
	});

	it("keeps header-shaped prose byte-identical", () => {
		// The length floors on the Authorization patterns exist so ordinary
		// command output is never rewritten. Redaction that corrupts normal
		// stdout gets turned off, which is strictly worse than no redaction.
		for (const line of [
			"Authorization: required for this endpoint",
			"Authorization: none",
			"region=AsiaPacificRegion123 selected",
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855  file.txt",
			"404fd6cd53 Merge pull request #19662 from elizaOS/develop",
		]) {
			expect(redactSensitiveText(line)).toBe(line);
		}
	});

	it("masks the credential, not the scheme, when the two are identical", () => {
		// `String.replace(string)` rewrites the FIRST occurrence; when the
		// credential also appears earlier in the match it masked the scheme and
		// left the credential itself in the output.
		const out = redactSensitiveText("Authorization: abcdefgh abcdefgh");
		expect(out).toBe("Authorization: abcdefgh ***");
	});

	it("masks an AWS access key id", () => {
		// The ENV-name rule cannot reach these: the canonical variable is
		// `AWS_ACCESS_KEY_ID`, whose last word is `ID`, so an `env` dump leaked
		// the key id while the paired `AWS_SECRET_ACCESS_KEY` was masked.
		for (const id of ["AKIAIOSFODNN7EXAMPLE", "ASIAY34FZKBOKMUTVV7A"]) {
			expect(redactSensitiveText(`AWS_ACCESS_KEY_ID=${id}`)).not.toContain(id);
			expect(redactSensitiveText(`bare ${id} here`)).not.toContain(id);
		}
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
