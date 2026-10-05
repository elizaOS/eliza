import { describe, expect, it } from "vitest";
import { GuardedStreamScanner } from "../security/guarded-stream";
import { SecretSwapSession } from "../security/secret-swap";

describe("local user reply restoration", () => {
	it("restores contact data while retaining substitution on the model side", () => {
		const session = new SecretSwapSession();
		const text = "Contact alpha.probe@example.invalid";
		const wire = session.substituteText(text);
		expect(wire).not.toContain("alpha.probe@example.invalid");
		expect(session.restoreUserReplyText(wire)).toBe(text);
	});
	it("does not restore configured credentials even with a PII-like setting name", () => {
		const secret = "alpha.probe@example.invalid";
		const session = new SecretSwapSession({ knownSecrets: { email: secret } });
		const wire = session.substituteText(secret);
		expect(session.restoreUserReplyText(wire)).toBe("[redacted credential]");
		expect(session.restoreText(wire)).toBe(secret);
	});
	it("upgrades previously detected contact data when later seen as a credential", () => {
		const value = "alpha.probe@example.invalid";
		const session = new SecretSwapSession();
		const first = session.substituteText(value);
		session.substituteText(JSON.stringify({ password: value }));
		expect(session.restoreUserReplyText(first)).toBe("[redacted credential]");
	});
	it("retains actual token redaction and can still restore tool parameters separately", () => {
		const value = "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
		const session = new SecretSwapSession();
		const wire = session.substituteText(value);
		expect(session.restoreUserReplyText(wire)).toBe("[redacted credential]");
		expect(session.restoreText(wire)).toBe(value);
	});
	it("keeps personal data redacted when it overlaps a configured credential", () => {
		const value = "alpha.probe@example.invalid";
		const session = new SecretSwapSession({
			knownSecrets: { token: "prefix-" + value + "-suffix" },
		});
		const wire = session.substituteText(value);
		expect(session.restoreUserReplyText(wire)).toBe("[redacted credential]");
	});
	it("cannot resolve another session or legacy placeholders", () => {
		const first = new SecretSwapSession();
		const wire = first.substituteText("alpha.probe@example.invalid");
		const second = new SecretSwapSession();
		second.substituteText("other@example.invalid");
		expect(second.restoreUserReplyText(wire)).toBe(wire);
		expect(second.restoreUserReplyText("__ELIZA_SECRET_0__")).toBe(
			"__ELIZA_SECRET_0__",
		);
	});
	it("does not expose an unresolved current-session placeholder", () => {
		const session = new SecretSwapSession();
		const wire = session.substituteText("alpha.probe@example.invalid");
		expect(
			session.restoreUserReplyText(wire.replace(/_\d+__$/, "_999__")),
		).toBe("[redacted credential]");
	});
});

describe("streamed personal data reply restoration", () => {
	it("restores every split of a contact placeholder without exposing a credential", () => {
		for (let split = 1; split < 100; split++) {
			const email = "alpha.probe@example.invalid",
				key = "synthetic-private-key-123456789";
			const session = new SecretSwapSession({ knownSecrets: { key } });
			const wire = session.substituteText(
				`Contact ${email}, credential ${key}.`,
			);
			const scanner = new GuardedStreamScanner({ secretSession: session });
			const chunks = [
				scanner.push(wire.slice(0, split)),
				scanner.push(wire.slice(split)),
				scanner.flush(),
			];
			expect(chunks.map((x) => x.safe).join("")).not.toContain(email);
			expect(chunks.map((x) => x.visible).join("")).toBe(
				`Contact ${email}, credential [redacted credential].`,
			);
		}
	});
});
