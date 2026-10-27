import { expect, it } from "vitest";
import {
	containsResourceAddress,
	parseWebResourceAddress,
} from "./resource-address.ts";

it.each([
	"example.com",
	"example.com:8443/path",
	"www.example.com/path?q=1",
	"https://example.com/path",
	"https://xn--bcher-kva.de/",
	"localhost:8080",
	"127.0.0.1:3000",
	"192.168.1.10:8080/admin",
])("recognizes a web resource without network access: %s", (text) => {
	expect(parseWebResourceAddress(text)?.protocol).toBe("https:");
	expect(containsResourceAddress(`Open ${text}.`)).toBe(true);
});
it.each([
	"Notes",
	"workflows",
	"search terms",
	"example..com",
	"https://",
	"https://bad host/",
	"person@example.com",
	"javascript:alert(1)",
	"1.2",
	"localhost",
	"127.0.0.1",
])("does not declare an eligible web address: %s", (text) =>
	expect(parseWebResourceAddress(text)).toBeUndefined(),
);
it("preserves other explicit resources for planning, never treating them as app-only navigation", () => {
	expect(containsResourceAddress("Open file:///tmp/report.pdf")).toBe(true);
	expect(containsResourceAddress("Open https://")).toBe(true);
	expect(containsResourceAddress("Open Notes")).toBe(false);
	expect(parseWebResourceAddress("http://localhost:8080")?.protocol).toBe(
		"http:",
	);
	expect(parseWebResourceAddress("[::1]:8080")?.protocol).toBe("https:");
});
