/** Exercises the real full-browser navigation boundary without launching a user session. */
import { describe, expect, it } from "vitest";
import { validateSystemBrowserUrl } from "./system-browser";

describe("full browser navigation", () => {
	it("preserves authentication callback queries and fragments", () => {
		const url =
			"https://accounts.google.com/signin?continue=https%3A%2F%2Fgoogle.com#next";
		expect(validateSystemBrowserUrl(url)).toBe(url);
	});
	it.each([
		"javascript:alert(1)",
		"file:///tmp/page",
		"--no-sandbox",
		"https://user:password@example.com",
		"https://example.com:65536",
	])("rejects unsafe navigation %s", (url) => {
		expect(() => validateSystemBrowserUrl(url)).toThrow();
	});
});
