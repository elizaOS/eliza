/**
 * Unit tests (deterministic, no runtime) for `sanitizeExperienceText`, which
 * redacts PII/secrets out of experience text before it is persisted into agent
 * memory (#8801 — it shipped untested). A regression here leaks emails, IPs,
 * home-dir usernames, or API tokens into stored experiences, so each redaction
 * class + the fail-safe truncation are pinned.
 */
import { describe, expect, it } from "vitest";
import { sanitizeExperienceText } from "./experienceText";

describe("sanitizeExperienceText", () => {
	it("returns a placeholder for empty input", () => {
		expect(sanitizeExperienceText("")).toBe("Unknown context");
		expect(sanitizeExperienceText(undefined as unknown as string)).toBe(
			"Unknown context",
		);
	});

	it("redacts email addresses", () => {
		const out = sanitizeExperienceText("ping me at jane.doe@example.com today");
		expect(out).toContain("[EMAIL]");
		expect(out).not.toContain("jane.doe@example.com");
	});

	it("redacts IPv4 addresses", () => {
		const out = sanitizeExperienceText("the box at 192.168.10.42 went down");
		expect(out).toContain("[IP]");
		expect(out).not.toContain("192.168.10.42");
	});

	it("redacts the username out of home directory paths", () => {
		expect(sanitizeExperienceText("opened /Users/alice/secret.txt")).toBe(
			"opened /Users/[USER]/secret.txt",
		);
		expect(sanitizeExperienceText("ran /home/bob/.ssh/id_rsa")).toBe(
			"ran /home/[USER]/.ssh/id_rsa",
		);
	});

	it("redacts prefixed API tokens (OpenAI / GitHub / Slack shapes)", () => {
		for (const token of [
			"sk-abcdefghijklmnop1234",
			"ghp_abcdefghijklmnop1234",
			"xoxb-abcdefghijklmnop",
		]) {
			const out = sanitizeExperienceText(`the key is ${token} keep it safe`);
			expect(out).toContain("[TOKEN]");
			expect(out).not.toContain(token);
		}
	});

	it("redacts any long opaque token-like run (32+ chars)", () => {
		const blob = "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7"; // 33 chars
		const out = sanitizeExperienceText(`secret ${blob} end`);
		expect(out).toContain("[TOKEN]");
		expect(out).not.toContain(blob);
	});

	it("neutralizes third-party attribution to a generic phrasing", () => {
		// only the "<subject> <verb>" span is rewritten; surrounding words stay
		expect(sanitizeExperienceText("the user asked about billing")).toBe(
			"the when asked about billing",
		);
		expect(sanitizeExperienceText("someone mentioned a bug")).toBe(
			"when asked a bug",
		);
	});

	it("truncates to 200 characters (bounded memory footprint)", () => {
		const long = "word ".repeat(80).trim(); // ~399 chars, spaced (no token run)
		const out = sanitizeExperienceText(long);
		expect(out.length).toBe(200);
	});

	it("leaves benign text untouched", () => {
		expect(sanitizeExperienceText("I prefer concise answers")).toBe(
			"I prefer concise answers",
		);
	});
});
