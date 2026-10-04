import { describe, expect, it } from "vitest";
import {
	assertPublicHttpsEndpoint,
	isPublicInternetAddress,
} from "./public-endpoint";

describe("strict public destination policy", () => {
	it.each([
		"127.0.0.1",
		"10.0.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"192.0.2.1",
		"192.31.196.1",
		"192.52.193.1",
		"192.88.99.1",
		"192.175.48.1",
		"198.18.0.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"240.0.0.1",
		"::1",
		"::127.0.0.1",
		"::ffff:127.0.0.1",
		"64:ff9b::a9fe:a9fe",
		"64:ff9b:1::808:808",
		"2001:db8::1",
		"2001:2::1",
		"fc00::1",
		"fe80::1",
		"2620:4f:8000::1",
		"3fff::1",
		"100::1",
		"garbage",
		"8.8.8.8%eth0",
		"8.8.8.8 ",
	])("rejects %s", (address) => {
		expect(isPublicInternetAddress(address)).toBe(false);
		expect(
			isPublicInternetAddress(address, undefined, {
				allowTranslatedIpv4: true,
			}),
		).toBe(false);
	});
	it.each([
		"8.8.8.8",
		"2606:4700:4700::1111",
		"::ffff:8.8.8.8",
		"64:ff9b::808:808",
		"2002:0808:0808::1",
	])("accepts public %s", (address) => {
		expect(isPublicInternetAddress(address)).toBe(true);
	});
	it("preserves the narrower identity-provider policy for translated IPv4", () => {
		expect(isPublicInternetAddress("::ffff:0:808:808", 6)).toBe(false);
		expect(
			isPublicInternetAddress("::ffff:0:808:808", 6, {
				allowTranslatedIpv4: true,
			}),
		).toBe(true);
		expect(
			isPublicInternetAddress("::ffff:0:7f00:1", 6, {
				allowTranslatedIpv4: true,
			}),
		).toBe(false);
		expect(isPublicInternetAddress("8.8.8.8", 6)).toBe(false);
	});
	it.each([
		"https://localhost/",
		"https://a.internal/",
		"https://a.onion/",
		"http://example.com/",
		"https://user:pass@example.com/",
		"https://2130706433/",
	])("rejects endpoint %s", (value) => {
		expect(() => assertPublicHttpsEndpoint(value, "Fixture")).toThrow();
	});
});
