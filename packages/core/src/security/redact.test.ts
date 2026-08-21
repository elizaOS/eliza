/**
 * Secret redaction is the last line stopping API keys / tokens / character
 * secrets from leaking into logs, tool output, or memories. Known secrets are
 * replaced wholesale by [REDACTED:name] (longest-first so one secret can't be
 * partially masked), and pattern detection masks common key shapes (sk-, ghp_,
 * Bearer, PEM) even when the value isn't in the known-secrets map. A full secret
 * value must never survive in the output.
 */

import { __loggerTestHooks } from "@elizaos/logger";
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
	it("keeps the core and leaf logger credential-shape policies synchronized", () => {
		expect(__loggerTestHooks.getSensitiveTextPatternsForTests()).toEqual(
			getDefaultRedactPatterns(),
		);
	});

	it("masks the common JSON credential spellings (W10 pattern-library sync)", () => {
		// Both implementations compile this same JSON-fields alternation; the
		// snake_case forms are separate alternatives because case-insensitive
		// matching does not bridge the underscore.
		for (const [key, value] of [
			["clientSecret", "client-secret-value-123"],
			["client_secret", "client-snake-secret-value-123"],
			["sessionKey", "session-secret-value-123"],
			["session_key", "session-snake-secret-value-123"],
			["authToken", "auth-secret-value-123"],
			["auth_token", "auth-snake-secret-value-123"],
			["botToken", "bot-secret-value-123"],
			["bot_token", "bot-snake-secret-value-123"],
			["connectionString", "Server=db;Pwd=hunter2w10"],
			["connection_string", "Server=db;Pwd=hunter2snake"],
			["access_token", "access-secret-value-123"],
			["refresh_token", "refresh-secret-value-123"],
			["webhookUrl", "https://discord.test/api/webhooks/9/hook-secret-a"],
			["webhook_url", "https://discord.test/api/webhooks/9/hook-secret-b"],
		]) {
			const out = redactSensitiveText(`{"${key}":"${value}"}`);
			expect(out, key).not.toContain(value);
		}
	});

	it("does not mask plural or lookalike JSON keys", () => {
		// The closing quote after the alternation is the boundary: a pluralized
		// or merely similar key must not fold into the credential set.
		const benign =
			'{"sessionKeys":"ab-cd","session_keys":"ef-gh","monkey":"see","authored":"by-me","connection_strings":"docs"}';
		expect(redactSensitiveText(benign)).toBe(benign);
	});

	it("masks a quoted credential key the ENV-style row cannot reach", () => {
		// The ENV-style assignment pattern requires the key's word boundary to be
		// followed immediately by `=`/`:`; a quoted key's closing quote always
		// intervenes, so `{"api_key": "..."}` matched nothing before this fix.
		// Assembled at runtime so no scannable secret-shaped literal sits in
		// source (gitleaks/push-protection).
		const value = ["sk", "_live_51H8xQ2LmNpQrStUv"].join("");
		for (const [key, quote] of [
			["api_key", '"'],
			["api-key", '"'],
			["api_key", "'"],
		] as const) {
			const body = `${quote}${key}${quote}: ${quote}${value}${quote}`;
			const out = redactSensitiveText(`{${body}}`);
			expect(out, `${key} (${quote})`).not.toContain(value);
		}
		// A prefixed name vocabulary still requires the separator before the
		// credential word — "monkey" must not fold into "key".
		const benign = '{"context_monkey": "banana bread"}';
		expect(redactSensitiveText(benign)).toBe(benign);
	});

	it("masks Google OAuth refresh and access tokens", () => {
		// `1//0...` (refresh) and `ya29....` (access) both survive a
		// `\b`-anchored alphanumeric pattern because `1//` opens with a digit
		// followed by slashes, which `\b` does not separate from what precedes
		// it. Assembled at runtime per the fixture convention above.
		const refreshToken = ["1//0", "AbCdEfGhIjKlMnOpQrStUvWxYz1234567890"].join("");
		const accessToken = ["ya29.", "AbCdEfGhIjKlMnOpQrStUvWxYz1234-5678_90"].join("");
		for (const token of [refreshToken, accessToken]) {
			const out = redactSensitiveText(`token endpoint returned ${token} in the body`);
			expect(out, token).not.toContain(token);
		}
	});

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

	it("masks token68 credentials for origin, proxy, and extension schemes", () => {
		const basic = ["dXNlcjpzdXBl", "cnNlY3JldA=="].join("");
		for (const input of [
			`Authorization: Basic ${basic}`,
			`Proxy-Authorization: Basic ${basic}`,
			`Authorization: Custom ${basic}`,
			`Authorization: ${basic}`,
		]) {
			const output = redactSensitiveText(input);
			expect(output).not.toContain(basic);
		}
	});

	it("masks the complete Digest auth-param remainder", () => {
		const username = ["private", "-user"].join("");
		const response = ["6629fae49393", "a05397450978507c4ef1"].join("");
		const input = `Authorization: Digest username="${username}", realm="restricted", response="${response}"`;
		const output = redactSensitiveText(input);
		expect(output).toContain("Authorization: Digest ");
		expect(output).not.toContain(username);
		expect(output).not.toContain("restricted");
		expect(output).not.toContain(response);
	});

	it("masks unquoted Digest auth params with RFC boundary whitespace", () => {
		const username = ["private", "-user"].join("");
		const response = ["6629fae49393", "a05397450978507c4ef1"].join("");
		const input = `Authorization: Digest username = ${username}, realm = restricted, response = ${response}`;
		const output = redactSensitiveText(input);
		expect(output).toContain("Authorization: Digest ");
		expect(output).not.toContain(username);
		expect(output).not.toContain("restricted");
		expect(output).not.toContain(response);
	});

	it("masks unquoted auth params with boundary whitespace only after equals", () => {
		const username = ["private", "-user"].join("");
		const response = ["6629fae49393", "a05397450978507c4ef1"].join("");
		for (const input of [
			`Authorization: Digest username= ${username}`,
			`Authorization: Digest username= ${username}, realm= restricted, response= ${response}`,
		]) {
			const output = redactSensitiveText(input);
			expect(output).toContain("Authorization: Digest ");
			expect(output).not.toContain(username);
			expect(output).not.toContain("restricted");
			expect(output).not.toContain(response);
		}
	});

	it("accepts the complete RFC token grammar for schemes and auth-param names", () => {
		const secret = ["private", "-user"].join("");
		const tokenInitials = [
			"0",
			"!",
			"#",
			"$",
			"%",
			"&",
			"'",
			"*",
			"+",
			"-",
			".",
			"^",
			"_",
			"`",
			"|",
			"~",
		];
		for (const initial of tokenInitials) {
			const input = `Authorization: ${initial}Custom ${initial}user=${secret}, realm=restricted`;
			const output = redactSensitiveText(input);
			expect(output).not.toContain(secret);
			expect(output).not.toContain("restricted");
		}
		const proxy = redactSensitiveText(
			`Proxy-Authorization: _Custom 1user=${secret}, realm=restricted`,
		);
		expect(proxy).not.toContain(secret);
		expect(proxy).not.toContain("restricted");
	});

	it("masks token and quoted auth-param values for every BWS permutation", () => {
		const secret = ["private", "-user"].join("");
		const assignments = [
			`username=${secret}`,
			`username =${secret}`,
			`username= ${secret}`,
			`username = ${secret}`,
			`username="${secret}"`,
			`username ="${secret}"`,
			`username= "${secret}"`,
			`username = "${secret}"`,
		];
		for (const assignment of assignments) {
			const output = redactSensitiveText(
				`Authorization: Digest ${assignment}, realm=restricted`,
			);
			expect(output).not.toContain(secret);
			expect(output).not.toContain("restricted");
		}
		const tokenValue = "!#$%&'*+-.^_`|~09AZaz";
		const tokenOutput = redactSensitiveText(
			`Authorization: Digest username=${tokenValue}, realm=restricted`,
		);
		expect(tokenOutput).not.toContain(tokenValue);
		expect(tokenOutput).not.toContain("restricted");
	});

	it("parses quoted commas and escaped quotes inside auth-param values", () => {
		const secret = ["private", ",zone", '\\"two'].join("");
		const output = redactSensitiveText(
			`Authorization: Digest username="${secret}", realm="restricted,west"`,
		);
		expect(output).not.toContain(secret);
		expect(output).not.toContain("restricted,west");
	});

	it("tolerates empty list elements without exposing auth-param values", () => {
		const secret = ["private", "-user"].join("");
		const output = redactSensitiveText(
			`Authorization: Digest , , username=${secret},, realm=restricted,`,
		);
		expect(output).not.toContain(secret);
		expect(output).not.toContain("restricted");
	});

	it("fails toward masking for a malformed auth-param assignment", () => {
		const secret = ["private", "-user"].join("");
		const output = redactSensitiveText(
			`Authorization: Digest username="${secret}, realm=restricted`,
		);
		expect(output).not.toContain(secret);
		expect(output).not.toContain("restricted");
	});

	it("masks only a Basic token68 value when diagnostic prose follows", () => {
		const tokens = [
			["dXNlcjpwYXNzd2", "9yZDEyMw="].join(""),
			["dXNlcjpwYXNz", "d29yZDEyMw=="].join(""),
		];
		for (const token of tokens) {
			for (const prose of ["trailing", "trailing diagnostic prose"]) {
				const output = redactSensitiveText(
					`Authorization: Basic ${token} ${prose}`,
				);
				expect(output).not.toContain(token);
				expect(output.endsWith(` ${prose}`)).toBe(true);
			}
		}
	});

	it("keeps token68 padding out of the auth-param branch for both padding widths", () => {
		// One- and two-"=" padded token68 credentials followed by prose: the
		// auth-param branch must not consume the prose to end-of-line (that
		// divergence is what broke whole-buffer vs guarded-stream equivalence).
		// Value-exact masking of the token itself is owned by the secret-swap
		// session in the streaming path, not this pattern table.
		const doublePad = ["dXNlcjpwYXNz", "d29yZDEyMw=="].join("");
		const singlePad = ["dXNlcjpwYXNzd2", "9yZDEyMw="].join("");
		for (const token of [doublePad, singlePad]) {
			const output = redactSensitiveText(
				`Header Authorization: Basic ${token} end of line.`,
			);
			expect(output).toContain(" end of line.");
		}
	});

	it("masks quoted Digest auth params with RFC boundary whitespace", () => {
		const username = ["private", "-user"].join("");
		const response = ["6629fae49393", "a05397450978507c4ef1"].join("");
		const input = `Authorization: Digest username = "${username}", realm = "restricted", response = "${response}"`;
		const output = redactSensitiveText(input);
		expect(output).toContain("Authorization: Digest ");
		expect(output).not.toContain(username);
		expect(output).not.toContain("restricted");
		expect(output).not.toContain(response);
	});

	it("does not rewrite invalid header-shaped prose", () => {
		for (const line of [
			"Authorization: required for this endpoint",
			"Authorization: none",
			"Proxy-Authorization: unavailable for local requests",
		]) {
			expect(redactSensitiveText(line)).toBe(line);
		}
	});

	it("masks the credential tail when it repeats the scheme", () => {
		expect(redactSensitiveText("Authorization: abcdefgh abcdefgh")).toBe(
			"Authorization: abcdefgh ***",
		);
		for (const whitespace of [" ", "\t"]) {
			expect(
				redactSensitiveText(`Authorization: abcdefgh abcdefgh${whitespace}`),
			).toBe(`Authorization: abcdefgh ***${whitespace}`);
			expect(
				redactSensitiveText(
					`Proxy-Authorization: abcdefgh abcdefgh${whitespace}`,
				),
			).toBe(`Proxy-Authorization: abcdefgh ***${whitespace}`);
		}
	});

	it("masks AWS credential identifiers without storing scanner fixtures", () => {
		const ids = [
			["AKIA", "IOSFODNN7EXAMPLE"].join(""),
			["ASIA", "Y34FZKBOKMUTVV7A"].join(""),
		];
		for (const id of ids) {
			expect(redactSensitiveText(`AWS_ACCESS_KEY_ID=${id}`)).not.toContain(id);
			expect(redactSensitiveText(`bare ${id} here`)).not.toContain(id);
		}
		expect(redactSensitiveText("AsiaPacificRegion123 selected")).toBe(
			"AsiaPacificRegion123 selected",
		);
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

	it("does not flag benign keys, including exact token telemetry fields", () => {
		for (const key of [
			"userId",
			"count",
			"tokenId",
			"tokenCount",
			"max_tokens",
			"promptTokens",
			"cacheReadInputTokens",
			"name",
			"url",
			"status",
		]) {
			expect(isSensitiveKeyName(key)).toBe(false);
		}
		expect(isSensitiveKeyName("accessTokens")).toBe(true);
	});

	it("flags the closed concat key set without catching key lookalikes", () => {
		// master/encryption concatenations had no word boundary for the substring
		// rules, so pattern-inert values under them leaked; the closed suffix set
		// matches the leaf logger's isSensitiveLogKey and the agent's
		// isSensitiveConfigKey without opening `key$` to lookalikes.
		for (const key of [
			"masterKey",
			"master_key",
			"MASTERKEY",
			"MASTER_KEY",
			"encryptionKey",
			"encryption-key",
			"ENCRYPTIONKEY",
			"signingKey",
			"SIGNINGKEY",
			"sshKey",
			"SSHKEY",
		]) {
			expect(isSensitiveKeyName(key), key).toBe(true);
		}
		for (const key of ["monkey", "turnkey", "hotkey", "keyboard", "KEYBOARD"]) {
			expect(isSensitiveKeyName(key), key).toBe(false);
		}
	});
});

/**
 * redactLogArgs is the sink-level redactor: it masks secrets structurally so a
 * logger that pipes its args through it protects `{ apiKey }` with no
 * redact.context() at the call site (#12229 M6). The clone also drops function
 * values outright — a copied toJSON/valueOf hook re-runs when the sink
 * JSON-stringifies the output and would reconstitute the masked secrets.
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

	it("drops a hostile own toJSON so serialization cannot reconstitute secrets", () => {
		const secret = "sk-tojson-resurrected-secret";
		const hostile = {
			apiKey: secret,
			note: "kept",
			// The marker is not pattern-shaped, so it can only reach the output
			// by the hook re-running at JSON.stringify.
			toJSON: () => ({ apiKey: secret, marker: "top-resurrected" }),
		};
		const [ctx] = redactLogArgs([hostile]) as [Record<string, unknown>];
		expect("toJSON" in ctx).toBe(false);
		expect(ctx.apiKey).toBe("[REDACTED]");
		expect(ctx.note).toBe("kept");
		const serialized = JSON.stringify(ctx);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("top-resurrected");
	});

	it("drops serializer hooks in nested objects and array elements", () => {
		const secret = "sk-nested-hook-secret-value";
		const [ctx] = redactLogArgs([
			{
				nested: {
					hook: { toJSON: () => ({ marker: "nested-resurrected" }) },
					ok: 1,
				},
				list: [
					{ toJSON: () => ({ marker: "array-resurrected" }) },
					secret,
					Object.assign(() => secret, {
						toJSON: () => ({ marker: "fn-resurrected" }),
					}),
				],
			},
		]) as [Record<string, unknown>];
		const nested = ctx.nested as Record<string, unknown>;
		expect(nested.ok).toBe(1);
		expect(nested.hook).toEqual({});
		// A function inside an array collapses to null, matching JSON array
		// serialization semantics.
		expect(ctx.list).toEqual([{}, "sk-nes…alue", null]);
		const serialized = JSON.stringify(ctx);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("resurrected");
	});

	it("does not invoke a caller-owned array map or preserve a hostile array species", () => {
		const secret = "sk-array-clone-hook-secret-value";
		const ownMap = [{ apiKey: secret }];
		Object.assign(ownMap, {
			map: () => ownMap,
			toJSON: () => ({ marker: "own-map-resurrected", secret }),
		});

		class HostileArray extends Array<unknown> {
			toJSON() {
				return { marker: "species-resurrected", secret };
			}
		}
		const hostileSpecies = new HostileArray();
		hostileSpecies.push({ apiKey: secret });

		const [ownMapOut, speciesOut] = redactLogArgs([ownMap, hostileSpecies]) as [
			unknown[],
			unknown[],
		];
		expect(ownMapOut).not.toBe(ownMap);
		expect(speciesOut).not.toBeInstanceOf(HostileArray);
		expect(ownMapOut).toEqual([{ apiKey: "[REDACTED]" }]);
		expect(speciesOut).toEqual([{ apiKey: "[REDACTED]" }]);
		const serialized = JSON.stringify([ownMapOut, speciesOut]);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("resurrected");
	});

	it("uses a null-prototype object clone", () => {
		const input = JSON.parse('{"__proto__":{"note":"untrusted"},"ok":1}');
		const [out] = redactLogArgs([input]) as [Record<string, unknown>];
		expect(Object.getPrototypeOf(out)).toBeNull();
		expect(Object.hasOwn(out, "__proto__")).toBe(true);
		expect(out.ok).toBe(1);
	});

	it("drops valueOf/toString hooks alongside toJSON", () => {
		const secret = "sk-valueof-hook-secret-value";
		const [ctx] = redactLogArgs([
			{
				note: "kept",
				valueOf: () => secret,
				toString: () => secret,
			},
		]) as [Record<string, unknown>];
		expect(ctx).toEqual({ note: "kept" });
		expect(JSON.stringify(ctx)).not.toContain(secret);
	});

	it("drops an own toJSON on a class instance and never inherits the prototype's", () => {
		const secret = "sk-class-hook-secret-value";
		class Payload {
			note = "kept";
			apiKey = secret;
			toJSON() {
				return { marker: "prototype-resurrected" };
			}
		}
		const ownHooked = Object.assign(new Payload(), {
			toJSON: () => ({ marker: "own-resurrected" }),
		});
		const [plain, hooked] = redactLogArgs([new Payload(), ownHooked]) as [
			Record<string, unknown>,
			Record<string, unknown>,
		];
		for (const clone of [plain, hooked]) {
			expect("toJSON" in clone).toBe(false);
			expect(clone.apiKey).toBe("[REDACTED]");
			expect(clone.note).toBe("kept");
		}
		const serialized = JSON.stringify([plain, hooked]);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("resurrected");
	});

	it("keeps the Error shape while a hostile own toJSON does not survive", () => {
		const secret = "sk-error-hook-secret-value";
		const err = Object.assign(new Error(`boom ${secret}`), {
			toJSON: () => ({ marker: "error-resurrected", secret }),
		});
		const [out] = redactLogArgs([err]) as [Error];
		expect(out).toBeInstanceOf(Error);
		expect(out.name).toBe("Error");
		expect(out.message).not.toContain(secret);
		expect("toJSON" in out).toBe(false);
		const serialized = JSON.stringify(out);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain("error-resurrected");
	});

	it("does not let a hostile own toJSON on a Date reconstitute a secret", () => {
		const secret = "sk-date-hook-secret-value";
		const when = new Date("2026-01-02T03:04:05.000Z");
		when.toJSON = () => secret;
		const [ctx] = redactLogArgs([{ when }]) as [Record<string, unknown>];
		expect(JSON.stringify(ctx)).not.toContain(secret);
	});

	it("collapses a bare function argument even when it carries a hostile toJSON", () => {
		const secret = "sk-function-hook-secret-value";
		const fn = Object.assign(() => secret, { toJSON: () => secret });
		const [out] = redactLogArgs([fn]);
		expect(out).toBeNull();
		expect(JSON.stringify(redactLogArgs([fn]))).not.toContain(secret);
	});

	it("masks a pattern-inert value under a concat credential key", () => {
		// Neither value matches a credential shape — only the key name can catch
		// them. masterKey/encryptionKey had no separator for the substring rules
		// before the closed concat set, so these leaked verbatim.
		const [ctx] = redactLogArgs([
			{
				encryptionKey: "correct-horse-battery-staple",
				masterKey: "hunter2-master-value",
				monkey: "visible",
			},
		]) as [Record<string, unknown>];
		expect(ctx.encryptionKey).toBe("[REDACTED]");
		expect(ctx.masterKey).toBe("[REDACTED]");
		expect(ctx.monkey).toBe("visible");
		const serialized = JSON.stringify(ctx);
		expect(serialized).not.toContain("correct-horse-battery-staple");
		expect(serialized).not.toContain("hunter2-master-value");
	});

	it("masks Buffer/TypedArray/DataView/ArrayBuffer payloads with a size-only marker", () => {
		const secret = "sk-buffer-payload-secret";
		const buf = Buffer.from(secret, "utf8");
		const bytes = new TextEncoder().encode(secret);
		const view = new DataView(new ArrayBuffer(16));
		const raw = new ArrayBuffer(8);
		// A distinct instance for the nested slot: reusing `buf` would trip the
		// cycle guard on the second encounter, not the buffer branch.
		const deep = Buffer.from(secret, "utf8");
		const [ctx] = redactLogArgs([
			{ buf, bytes, view, raw, nested: { deep } },
		]) as [Record<string, unknown>];
		expect(ctx.buf).toBe(`[BUFFER REDACTED ${buf.byteLength} bytes]`);
		expect(ctx.bytes).toBe(`[BUFFER REDACTED ${bytes.byteLength} bytes]`);
		expect(ctx.view).toBe("[BUFFER REDACTED 16 bytes]");
		expect(ctx.raw).toBe("[BUFFER REDACTED 8 bytes]");
		expect(ctx.nested).toEqual({
			deep: `[BUFFER REDACTED ${deep.byteLength} bytes]`,
		});
		const serialized = JSON.stringify(ctx);
		// The pre-fix walk emitted the bytes as indexed properties (115 is 's'),
		// and Buffer's own toJSON would emit them as a data array — either shape
		// reconstitutes the secret byte-for-byte.
		expect(serialized).not.toContain('"0":115');
		expect(serialized).not.toContain("115,107");
	});

	it("does not let a hostile own toJSON on a Buffer reconstitute its bytes", () => {
		const secret = "sk-buffer-hook-secret-value";
		const hostile = Object.assign(Buffer.from(secret, "utf8"), {
			toJSON: () => secret,
		});
		const [out] = redactLogArgs([hostile]);
		expect(out).toBe(`[BUFFER REDACTED ${hostile.byteLength} bytes]`);
		expect(JSON.stringify(out)).not.toContain(secret);
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
