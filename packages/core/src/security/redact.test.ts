import { describe, expect, it } from "vitest";
import {
	createSecretsRedactor,
	getDefaultRedactPatterns,
	redactObjectSecrets,
	redactSecrets,
	redactSensitiveText,
	redactWithSecrets,
} from "./redact.ts";

/**
 * Secret redaction is the last line stopping API keys / tokens / character
 * secrets from leaking into logs, tool output, or memories. Known secrets are
 * replaced wholesale by [REDACTED:name] (longest-first so one secret can't be
 * partially masked), and pattern detection masks common key shapes (sk-, ghp_,
 * Bearer, PEM) even when the value isn't in the known-secrets map. A full secret
 * value must never survive in the output.
 */

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

	it("masks a GitHub PAT and a Bearer token", () => {
		const ghp = `ghp_${"a".repeat(30)}`;
		expect(redactSensitiveText(`use ${ghp}`)).not.toContain(ghp);
		const bearer = `Bearer ${"a".repeat(40)}`;
		expect(redactSensitiveText(bearer)).not.toContain("a".repeat(40));
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
