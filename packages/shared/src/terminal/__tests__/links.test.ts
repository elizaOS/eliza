import { describe, expect, it } from "vitest";
import { formatDocsLink, formatTerminalLink } from "./links.ts";

describe("formatTerminalLink", () => {
	it("formats OSC-8 when forced", () => {
		const out = formatTerminalLink("docs", "https://a.com", { force: true });
		expect(out).toContain("\u001b]8;;https://a.com\u0007docs\u001b]8;;\u0007");
	});

	it("falls back to label (url) when not allowed", () => {
		expect(formatTerminalLink("docs", "https://a.com")).toBe(
			"docs (https://a.com)",
		);
	});

	it("uses the custom fallback when provided", () => {
		expect(
			formatTerminalLink("docs", "https://a.com", { fallback: "see docs" }),
		).toBe("see docs");
	});

	it("strips control bytes from label and url", () => {
		const out = formatTerminalLink("a\u001b[31mred", "https://a.com/\u0007x", {
			force: true,
		});
		// The OSC-8 wrapper itself uses ESC/ST, but the label's ESC byte is removed.
		expect(out).toContain("a[31mred"); // ESC stripped, plain text kept
		expect(out).not.toContain("\u001b[31m");
		expect(out).toContain("https://a.com/x"); // URL control byte removed
	});
});

describe("formatDocsLink", () => {
	it("builds docs urls for relative paths", () => {
		const out = formatDocsLink("/agents", "agents", { force: true });
		expect(out).toContain("https://docs.eliza.ai/agents");
	});

	it("passes through absolute urls", () => {
		const out = formatDocsLink("https://example.com/x", undefined, {
			force: true,
		});
		expect(out).toContain("https://example.com/x");
	});
});
