/**
 * Unit suite for the SSRF policy core (ssrf.ts): pinned-lookup callback shapes,
 * private/link-local + blocked-hostname classification, resolution policy, and
 * non-canonical IPv4 encodings as bypass vectors. Deterministic — stub lookupFn.
 */
import { describe, expect, it } from "vitest";
import {
	createPinnedLookup,
	isBlockedHostname,
	isPrivateIpAddress,
	type LookupAddress,
	type LookupFn,
	resolvePinnedHostnameWithPolicy,
	SsrfBlockedError,
} from "./ssrf.ts";

describe("createPinnedLookup", () => {
	it("returns the Node single-address callback shape by default", async () => {
		const lookup = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10"],
		}) as (
			hostname: string,
			callback: (error: Error | null, address: string, family?: number) => void,
		) => void;

		await new Promise<void>((resolve, reject) => {
			lookup("example.com", (error, address, family) => {
				if (error) {
					reject(error);
					return;
				}
				expect(address).toBe("203.0.113.10");
				expect(family).toBe(4);
				resolve();
			});
		});
	});

	it("returns the Node all-address callback shape when requested", async () => {
		const lookup = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10"],
		}) as (
			hostname: string,
			options: { all: true },
			callback: (error: Error | null, addresses: LookupAddress[]) => void,
		) => void;

		await new Promise<void>((resolve, reject) => {
			lookup("example.com", { all: true }, (error, addresses) => {
				if (error) {
					reject(error);
					return;
				}
				expect(addresses).toEqual([{ address: "203.0.113.10", family: 4 }]);
				resolve();
			});
		});
	});

	it("drops undefined/empty addresses instead of pinning 'undefined'", async () => {
		const lookup = createPinnedLookup({
			hostname: "example.com",
			// An undefined/empty address reaches node's net layer and throws
			// "Invalid IP address: undefined" if pinned, so holes must be dropped.
			addresses: [undefined as unknown as string, "", "203.0.113.10"],
		}) as (
			hostname: string,
			options: { all: true },
			callback: (error: Error | null, addresses: LookupAddress[]) => void,
		) => void;

		await new Promise<void>((resolve, reject) => {
			lookup("example.com", { all: true }, (error, addresses) => {
				if (error) {
					reject(error);
					return;
				}
				expect(addresses).toEqual([{ address: "203.0.113.10", family: 4 }]);
				resolve();
			});
		});
	});
});

describe("SSRF policy enforcement", () => {
	it("classifies private and link-local address forms", () => {
		expect(isPrivateIpAddress("127.0.0.1")).toBe(true);
		expect(isPrivateIpAddress("169.254.169.254")).toBe(true);
		expect(isPrivateIpAddress("10.0.0.7")).toBe(true);
		expect(isPrivateIpAddress("172.20.0.1")).toBe(true);
		expect(isPrivateIpAddress("192.168.1.1")).toBe(true);
		expect(isPrivateIpAddress("100.64.0.1")).toBe(true);
		expect(isPrivateIpAddress("::1")).toBe(true);
		expect(isPrivateIpAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isPrivateIpAddress("::ffff:7f00:0001")).toBe(true);
		expect(isPrivateIpAddress("fc00::1")).toBe(true);
		expect(isPrivateIpAddress("fd00::1")).toBe(true);
		expect(isPrivateIpAddress("203.0.113.10")).toBe(false);
	});

	it("blocks localhost and internal hostnames after normalization", () => {
		expect(isBlockedHostname("LOCALHOST.")).toBe(true);
		expect(isBlockedHostname("metadata.google.internal")).toBe(true);
		expect(isBlockedHostname("service.local")).toBe(true);
		expect(isBlockedHostname("api.example.com")).toBe(false);
	});

	it("rejects blocked hostnames before DNS lookup", async () => {
		let lookupCalls = 0;
		const lookupFn: LookupFn = async () => {
			lookupCalls += 1;
			return [{ address: "203.0.113.10", family: 4 }];
		};

		await expect(
			resolvePinnedHostnameWithPolicy("localhost.", { lookupFn }),
		).rejects.toBeInstanceOf(SsrfBlockedError);
		expect(lookupCalls).toBe(0);
	});

	it("rejects public hostnames that resolve to private addresses", async () => {
		const lookupFn: LookupFn = async () => [
			{ address: "203.0.113.10", family: 4 },
			{ address: "169.254.169.254", family: 4 },
		];

		await expect(
			resolvePinnedHostnameWithPolicy("example.com", { lookupFn }),
		).rejects.toThrow("resolves to private/internal IP address");
	});

	it("fails closed when a host resolves to only undefined/empty addresses", async () => {
		const lookupFn: LookupFn = async () => [
			{ address: undefined as unknown as string, family: 4 },
			{ address: "", family: 4 },
		];

		await expect(
			resolvePinnedHostnameWithPolicy("example.com", { lookupFn }),
		).rejects.toThrow("Unable to resolve hostname");
	});

	it("allows explicit hostname exceptions without allowing every private network", async () => {
		const lookupFn: LookupFn = async () => [
			{ address: "169.254.169.254", family: 4 },
		];

		const pinned = await resolvePinnedHostnameWithPolicy(
			"metadata.google.internal",
			{
				lookupFn,
				policy: { allowedHostnames: ["metadata.google.internal"] },
			},
		);

		expect(pinned.addresses).toEqual(["169.254.169.254"]);
	});
});

describe("isPrivateIpAddress: non-canonical IPv4 encodings (SSRF bypass vectors)", () => {
	// The OS resolver (inet_aton/getaddrinfo) accepts octal, hex, plain-decimal,
	// and short-form IPv4. A literal-IP SSRF check must classify these the same
	// way the connection would, or http://0177.0.0.1/ reaches localhost.
	it("blocks octal / hex / decimal / short-form encodings of loopback", () => {
		for (const addr of [
			"0177.0.0.1", // octal 0177 = 127
			"0x7f.0.0.1", // hex 0x7f = 127
			"0x7f000001", // hex 32-bit 127.0.0.1
			"2130706433", // decimal 32-bit 127.0.0.1
			"127.1", // short form -> 127.0.0.1
			"127.0.1", // 3-part short form
			"::ffff:0177.0.0.1", // octal loopback inside an IPv4-mapped IPv6 literal
		]) {
			expect(isPrivateIpAddress(addr), addr).toBe(true);
		}
	});

	it("blocks non-canonical encodings of other private ranges", () => {
		expect(isPrivateIpAddress("0xa.0.0.1")).toBe(true); // 10.0.0.1
		expect(isPrivateIpAddress("0300.0250.0.1")).toBe(true); // octal 192.168.0.1
		expect(isPrivateIpAddress("3232235521")).toBe(true); // decimal 192.168.0.1
		expect(isPrivateIpAddress("2852039166")).toBe(true); // decimal 169.254.169.254
	});

	it("does NOT over-block legitimate public addresses", () => {
		for (const addr of [
			"8.8.8.8",
			"::ffff:8.8.8.8", // public IPv4-mapped IPv6 stays public
			"1.1.1.1",
			"203.0.113.10",
			"172.15.0.1", // just below the 172.16/12 private range
			"172.32.0.1", // just above it
			"192.169.1.1", // not 192.168/16
			"0xdeadbeef", // hex 222.173.190.239 (public)
			"3221234342", // decimal 192.0.34.166 (public)
		]) {
			expect(isPrivateIpAddress(addr), addr).toBe(false);
		}
	});

	it("returns false (not an IP) for non-numeric or malformed strings", () => {
		for (const s of [
			"example.com",
			"0x1.example.com",
			"1.2.3.4.5",
			"999.1.1.1",
			"8.8.8.08", // 08 is not a valid octal octet
			"",
			"...",
		]) {
			expect(isPrivateIpAddress(s), s).toBe(false);
		}
	});
});
