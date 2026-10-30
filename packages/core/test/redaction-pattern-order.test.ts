import { describe, expect, it } from "vitest";
import { redactSensitiveLogText } from "../src/security/log-redaction.ts";
import { redactSensitiveText } from "../src/security/redact.ts";

// Synthetic fixtures: not real key material.
const PEM_BODY = "MIIEowIBAAKCAQEAsyntheticPemBodyForRedactionOrderTest00";
const PGP_BODY = "lQOYBGsyntheticPgpBodyForRedactionOrderTest00000000";
const JWT =
	"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWRhY3Rpb24ifQ.c3ludGhldGljLXNpZ25hdHVyZQ";

const redactors = [
	["redactSensitiveText", redactSensitiveText],
	["redactSensitiveLogText", redactSensitiveLogText],
] as const;

describe.each(redactors)("%s pattern order", (_name, redact) => {
	it.each([
		[
			"an unquoted env assignment",
			`PRIVATE_KEY=-----BEGIN RSA PRIVATE KEY-----\n${PEM_BODY}\n-----END RSA PRIVATE KEY-----`,
		],
		[
			"a JSON-escaped container env entry",
			`"Env": ["SIGNING_KEY=-----BEGIN PRIVATE KEY-----\\n${PEM_BODY}\\n-----END PRIVATE KEY-----\\n"]`,
		],
	])("masks a PEM body assigned in %s", (_label, text) => {
		const output = redact(text);
		expect(output).not.toContain(PEM_BODY);
	});

	it.each([
		["X-Auth-Token: Bearer", `X-Auth-Token: Bearer ${JWT}`],
		["access_token: Bearer", `access_token: Bearer ${JWT}`],
	])("masks the credential after %s", (_label, text) => {
		const output = redact(text);
		expect(output).not.toContain(JWT);
	});

	it("masks a PGP private key block", () => {
		const output = redact(
			`-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${PGP_BODY}\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----`,
		);
		expect(output).not.toContain(PGP_BODY);
	});
});

describe("redactSensitiveText PEM rendering", () => {
	it("keeps the PGP armor lines around the redacted body", () => {
		expect(
			redactSensitiveText(
				`-----BEGIN PGP PRIVATE KEY BLOCK-----\n\n${PGP_BODY}\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----`,
			),
		).toBe(
			"-----BEGIN PGP PRIVATE KEY BLOCK-----\n…redacted…\n-----END PGP PRIVATE KEY BLOCK-----",
		);
	});
});
