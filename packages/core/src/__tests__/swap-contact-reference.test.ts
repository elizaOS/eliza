import { expect, test } from "vitest";
import { GuardedStreamScanner } from "../security/guarded-stream";
import { SecretSwapSession } from "../security/secret-swap";

const email = "synthetic.contact@example.invalid";
test("contact references restore locally but never travel as raw contact data", () => {
	const s = new SecretSwapSession();
	const wire = s.substituteText(`Contact ${email}`);
	expect(wire).toMatch(/__ELIZA_CONTACT_[0-9a-f]{16}_1__/);
	expect(wire).not.toContain(email);
	expect(s.substituteText(wire)).toBe(wire);
	expect(s.restoreUserReplyText(wire)).toBe(`Contact ${email}`);
	expect(s.restoreText(wire)).toBe(`Contact ${email}`);
});
test("credential precedence holds before and after contact recognition", () => {
	for (const first of [true, false]) {
		const s = new SecretSwapSession();
		const contact = first ? s.substituteText(email) : null;
		const credential = s.substituteText(`password=${email}`);
		expect(s.restoreUserReplyText(credential)).not.toContain(email);
		expect(s.restoreUserReplyText(contact ?? s.substituteText(email))).toBe(
			"[redacted credential]",
		);
	}
	const s = new SecretSwapSession({ knownSecrets: { email } });
	expect(s.substituteText(email)).toContain("__ELIZA_SECRET_");
});
test("other session and fabricated references cannot restore a contact", () => {
	const s = new SecretSwapSession(),
		other = new SecretSwapSession();
	const wire = s.substituteText(email);
	expect(other.restoreUserReplyText(wire)).toBe(wire);
	const forged = wire.replace(/_1__$/, "_999__");
	expect(s.restoreUserReplyText(forged)).toBe("[redacted credential]");
	expect(() => s.restoreText(forged, { failOnUnresolved: true })).toThrow();
	expect(() => s.assertNoUnresolvedPlaceholders(forged)).toThrow();
});
test("every contact placeholder stream split restores once without leaking into safe text", () => {
	for (let split = 1; split < 64; split++) {
		const s = new SecretSwapSession(),
			wire = s.substituteText(email);
		const scanner = new GuardedStreamScanner({ secretSession: s });
		const prefix = "Contact card. ".repeat(100);
		const parts = [
			scanner.push(prefix + wire.slice(0, split)),
			scanner.push(wire.slice(split) + " end"),
			scanner.flush(),
		];
		expect(parts.map((p) => p.safe).join("")).toBe(prefix + wire + " end");
		expect(parts.map((p) => p.visible).join("")).toBe(prefix + email + " end");
	}
});
