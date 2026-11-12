/** A host:port pair names a destination, not a search term: implicit
 * `localhost:3000` and `127.0.0.1:3000` are web resources, while a bare word,
 * a bare version-like number, and a bare host without a port are not. */

import { describe, expect, it } from "vitest";
import {
	containsResourceAddress,
	parseWebResourceAddress,
} from "../src/utils/resource-address";

describe("parseWebResourceAddress implicit host:port", () => {
	it.each([
		["localhost:8080", "localhost", "8080", "/"],
		["localhost:3000", "localhost", "3000", "/"],
		["127.0.0.1:3000", "127.0.0.1", "3000", "/"],
		["192.168.0.5:8080/path", "192.168.0.5", "8080", "/path"],
		["[::1]:8080", "[::1]", "8080", "/"],
		// `:443` is the default HTTPS port, so the URL parser strips it
		// from `url.port` — the address is still recognized (see the
		// review on this PR: the port is read from the authored text).
		["localhost:443", "localhost", "", "/"],
		["127.0.0.1:443", "127.0.0.1", "", "/"],
		["[::1]:443", "[::1]", "", "/"],
	])("recognizes %s as a web resource", (text, hostname, port, pathname) => {
		const url = parseWebResourceAddress(text);
		expect(url?.protocol).toBe("https:");
		expect(url?.hostname).toBe(hostname);
		expect(url?.port).toBe(port);
		expect(url?.pathname).toBe(pathname);
		expect(containsResourceAddress(`Open ${text}.`)).toBe(true);
	});

	it.each(["1.2", "1.2.3.4", "localhost", "example.123", "person@example.com"])(
		"still does not declare an eligible web address: %s",
		(text) => {
			expect(parseWebResourceAddress(text)).toBeUndefined();
			expect(containsResourceAddress(`Open ${text}.`)).toBe(false);
		},
	);

	it("still recognizes domain host:port and explicit localhost", () => {
		expect(parseWebResourceAddress("example.com:8443/path")?.protocol).toBe(
			"https:",
		);
		expect(parseWebResourceAddress("http://localhost:8080")?.protocol).toBe(
			"http:",
		);
	});

	it("still finds addresses wrapped in surrounding punctuation", () => {
		expect(containsResourceAddress("Open (example.com).")).toBe(true);
		expect(containsResourceAddress('Open "example.com".')).toBe(true);
		expect(containsResourceAddress("Open [example.com].")).toBe(true);
		expect(containsResourceAddress("Open Notes.")).toBe(false);
	});
});
