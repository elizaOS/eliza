import { describe, expect, it } from "vitest";
import { SecretSwapSession } from "../src/security/secret-swap";

describe("secret swapping structured model output", () => {
	it("preserves JSON primitives and keys while protecting credential strings", () => {
		const session = new SecretSwapSession({
			knownSecrets: {
				FLAG: "true",
				ZERO: "0",
				NIL: "null",
				KEY: "success",
				FALSE: "false",
			},
		});
		const input = {
			success: true,
			failed: false,
			count: 0,
			optional: null,
			password: "true",
			nested: [false, "false", 0, "0", null, "null"],
			label: "success",
		};
		const output = JSON.parse(session.substituteText(JSON.stringify(input)));
		expect(output).toMatchObject({
			success: true,
			failed: false,
			count: 0,
			optional: null,
		});
		expect(output.password).toMatch(/^__ELIZA_SECRET_/);
		expect(output.label).toMatch(/^__ELIZA_SECRET_/);
		expect(output.nested[0]).toBe(false);
		expect(output.nested[2]).toBe(0);
		expect(output.nested[4]).toBe(null);
		for (const i of [1, 3, 5])
			expect(output.nested[i]).toMatch(/^__ELIZA_SECRET_/);
	});
	it("protects fenced JSON and surrounding prose", () => {
		const session = new SecretSwapSession({
			knownSecrets: { PASSWORD: "true" },
		});
		const output = session.substituteText(
			'secret true\n```json\n{"success":true,"password":"true"}\n```\nagain true',
		);
		expect(output).not.toContain("secret true");
		expect(output).not.toContain("again true");
		const body = output.split("```json\n")[1].split("\n```")[0];
		expect(JSON.parse(body).success).toBe(true);
		expect(JSON.parse(body).password).toMatch(/^__ELIZA_SECRET_/);
	});
	it("keeps ordinary and malformed text redaction", () => {
		const session = new SecretSwapSession({
			knownSecrets: { PASSWORD: "true" },
		});
		expect(session.substituteText("password=true")).not.toContain("=true");
		expect(session.substituteText("{broken:true}")).not.toContain(":true");
	});
	it("protects escaped credentials and preserves Unicode and formatting", () => {
		const session = new SecretSwapSession({
			knownSecrets: { PASSWORD: 'hi "friend"' },
		});
		const input = String.raw` { "ok":true, "message":"hi \"friend\"", "city":"東京" } `;
		expect(() => JSON.parse(input)).not.toThrow();
		const output = session.substituteText(input);
		expect(JSON.parse(output).ok).toBe(true);
		expect(JSON.parse(output).city).toBe("東京");
		expect(JSON.parse(output).message).toMatch(/^__ELIZA_SECRET_/);
		expect(output.startsWith(' { "ok":true')).toBe(true);
	});
	it("handles JSON arrays and idempotent substitution", () => {
		const session = new SecretSwapSession({
			knownSecrets: { PASSWORD: "true" },
		});
		const first = session.substituteText('[true,"true",{"ok":true}]');
		const values = JSON.parse(first);
		expect(values[0]).toBe(true);
		expect(values[2].ok).toBe(true);
		expect(session.substituteText(first)).toBe(first);
	});
});
