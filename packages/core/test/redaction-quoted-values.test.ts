import { describe, expect, it } from "vitest";
import { redactSensitiveLogText } from "../src/security/log-redaction.ts";
import { redactSensitiveText } from "../src/security/redact.ts";

// Synthetic fixtures: not real credentials.
const redactors = [
	["redactSensitiveText", redactSensitiveText],
	["redactSensitiveLogText", redactSensitiveLogText],
] as const;

describe.each(redactors)("%s quoted values", (_name, redact) => {
	it.each([
		[
			"a JSON value holding an apostrophe",
			`{"db_password": "it's-my-Passw0rd-2024"}`,
			"it's-my-Passw0rd-2024",
			"Passw0rd",
		],
		[
			"a Python repr value holding an apostrophe",
			`{'password': "it's-my-Passw0rd-2024"}`,
			"it's-my-Passw0rd-2024",
			"Passw0rd",
		],
		[
			"a JSON value holding an escaped quote",
			String.raw`{"client_secret":"Zx9\"Qw8mN2pL5vR7tY1u"}`,
			String.raw`Zx9\"Qw8mN2pL5vR7tY1u`,
			"Qw8mN2pL5vR7",
		],
		[
			"a YAML value holding an apostrophe",
			`password: "it's-my-Passw0rd-2024"`,
			"it's-my-Passw0rd-2024",
			"Passw0rd",
		],
		[
			"a double-quoted env passphrase",
			`export DB_PASSWORD="correct horse battery staple"`,
			"correct horse battery staple",
			"horse battery",
		],
		[
			"a single-quoted env passphrase",
			`DB_PASSWORD='correct horse battery staple'`,
			"correct horse battery staple",
			"horse battery",
		],
		[
			"a quoted CLI flag passphrase",
			`mysql --password "correct horse battery staple"`,
			"correct horse battery staple",
			"horse battery",
		],
	])("masks %s", (_label, text, value, inner) => {
		const output = redact(text);
		expect(output).not.toContain(value);
		expect(output).not.toContain(inner);
	});

	it.each([
		[`{"admin_password":"admin"}`, `{"admin_password":"***"}`],
		[`{"root_password":"root"}`, `{"root_password":"***"}`],
		[`{"password":"pass"}`, `{"password":"***"}`],
	])("masks the value, not the key, in %s", (text, expected) => {
		expect(redact(text)).toBe(expected);
	});

	it("keeps unquoted values and text after the closing quote as before", () => {
		expect(redact(`password=hunter2 user=bob`)).toBe("password=*** user=bob");
		expect(redact(`DB_PASSWORD="hunter2" DB_USER="bob"`)).toBe(
			`DB_PASSWORD="***" DB_USER="bob"`,
		);
	});
});
