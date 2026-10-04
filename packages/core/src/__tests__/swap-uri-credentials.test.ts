import { expect, test } from "vitest";
import { GuardedStreamScanner } from "../security/guarded-stream";
import { SecretSwapSession } from "../security/secret-swap";

for (const uri of [
	"https://synthetic:alpha@bravo@example.invalid/path",
	"postgresql://user:alpha@bravo@localhost:5432/db",
	"HTTPS://user:alpha@@bravo@[::1]:8443/path",
	"https://:alpha@bravo@example.invalid/",
	"https://user:alpha%40bravo@example.invalid/path",
])
	test(`complete URI userinfo: ${uri}`, () => {
		const session = new SecretSwapSession(),
			text = `Read "${uri}" after approval.`,
			wire = session.substituteText(text);
		expect(wire).not.toContain("bravo");
		expect(wire).toContain("after approval.");
		expect(session.restoreText(wire)).toBe(text);
		expect(session.restoreUserReplyText(wire)).not.toContain("bravo");
		expect(session.substituteText(wire)).toBe(wire);
	});
for (const suffix of [
	"/public@route",
	"?public=@route",
	"#public@route",
	" public@route",
	'" public@route',
	"' public@route",
	"<public@route",
	"\\public@route",
])
	test(`URI authority ends before ${suffix}`, () => {
		const session = new SecretSwapSession({ disabledKinds: ["email"] }),
			text = "https://user:alpha@bravo@example.invalid" + suffix,
			wire = session.substituteText(text);
		expect(wire).not.toContain("bravo");
		expect(wire).toContain(suffix);
		expect(session.restoreText(wire)).toBe(text);
	});
test("ordinary URL paths and queries are not userinfo", () => {
	for (const text of [
		"https://example.invalid/path@route",
		"https://example.invalid/?q=one@two",
		"https://example.invalid/#one@two",
		"https:// public@route",
	]) {
		const session = new SecretSwapSession({ disabledKinds: ["email"] });
		expect(session.substituteText(text)).toBe(text);
	}
});
test("URI credentials remain protected at every stream boundary", () => {
	const uri = "https://user:alpha@bravo@example.invalid/path";
	for (let split = 1; split < uri.length; split++) {
		const session = new SecretSwapSession(),
			scanner = new GuardedStreamScanner({ secretSession: session });
		const parts = [
			scanner.push("Public padding ".repeat(100) + uri.slice(0, split)),
			scanner.push(uri.slice(split)),
			scanner.flush(),
		];
		expect(parts.map((p) => p.safe).join("")).not.toContain("bravo");
		expect(parts.map((p) => p.visible).join("")).not.toContain("bravo");
	}
});
