/**
 * Unit suite for the SSRF policy core (ssrf.ts): pinned-lookup callback shapes,
 * private/link-local + blocked-hostname classification, resolution policy, and
 * non-canonical IPv4 encodings as bypass vectors. Deterministic — stub lookupFn.
 */
import { describe, expect, it } from "vitest";
import {
	createPinnedLookup,
	isBlockedHostname,
	isLoopbackHost,
	isPrivateIpAddress,
	type LookupAddress,
	type LookupFn,
	normalizeHostLike,
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
	it("normalizes host literals and recognizes only actual loopback targets", () => {
		expect(normalizeHostLike("  [::1] ")).toBe("::1");
		expect(normalizeHostLike("EXAMPLE.COM.")).toBe("example.com");
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("127.5.6.7")).toBe(true);
		expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackHost("127somehost.example.com")).toBe(false);
		expect(isLoopbackHost("8.8.8.8")).toBe(false);
	});

	it("classifies private and link-local address forms", () => {
		expect(isPrivateIpAddress("127.0.0.1")).toBe(true);
		expect(isPrivateIpAddress("169.254.169.254")).toBe(true);
		expect(isPrivateIpAddress("10.0.0.7")).toBe(true);
		expect(isPrivateIpAddress("172.20.0.1")).toBe(true);
		expect(isPrivateIpAddress("192.168.1.1")).toBe(true);
		expect(isPrivateIpAddress("100.64.0.1")).toBe(true);
		expect(isPrivateIpAddress("100.127.255.254")).toBe(true);
		expect(isPrivateIpAddress("::1")).toBe(true);
		expect(isPrivateIpAddress("::ffff:127.0.0.1")).toBe(true);
		expect(isPrivateIpAddress("::ffff:7f00:0001")).toBe(true);
		expect(isPrivateIpAddress("0:0:0:0:0:ffff:7f00:0001")).toBe(true);
		expect(isPrivateIpAddress("fc00::1")).toBe(true);
		expect(isPrivateIpAddress("fd00::1")).toBe(true);
		expect(isPrivateIpAddress("fe9f::1")).toBe(true);
		expect(isPrivateIpAddress("febf::1")).toBe(true);
		expect(isPrivateIpAddress("fec0::1")).toBe(true);
		expect(isPrivateIpAddress("feff::1")).toBe(true);
		expect(isPrivateIpAddress("ff02::1")).toBe(true);
		expect(isPrivateIpAddress("203.0.113.10")).toBe(false);
		expect(isPrivateIpAddress("2001:4860:4860::8888")).toBe(false);
	});

	it("classifies the special-purpose parity ranges the cloud guard blocks", () => {
		// 198.18.0.0/15 (benchmarking) is internally routable on carrier/lab
		// networks; 192.0.0.0/24 holds IETF protocol assignments; 224/4 is
		// multicast and 240/4 is reserved (including 255.255.255.255).
		expect(isPrivateIpAddress("198.18.0.1")).toBe(true);
		expect(isPrivateIpAddress("198.19.255.254")).toBe(true);
		expect(isPrivateIpAddress("192.0.0.1")).toBe(true);
		expect(isPrivateIpAddress("192.0.0.170")).toBe(true);
		expect(isPrivateIpAddress("224.0.0.1")).toBe(true);
		expect(isPrivateIpAddress("239.255.255.255")).toBe(true);
		expect(isPrivateIpAddress("240.0.0.1")).toBe(true);
		expect(isPrivateIpAddress("255.255.255.255")).toBe(true);
		// Just outside each added range stays public.
		expect(isPrivateIpAddress("198.17.255.255")).toBe(false);
		expect(isPrivateIpAddress("198.20.0.1")).toBe(false);
		expect(isPrivateIpAddress("192.0.1.1")).toBe(false);
		expect(isPrivateIpAddress("223.255.255.255")).toBe(false);
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

describe("isPrivateIpAddress: IPv6 transition ranges embedding IPv4 (SSRF bypass vectors)", () => {
	// On NAT64/DNS64, 6to4, or Teredo network paths a literal URL never hits
	// DNS, so the guard must decode the embedded IPv4 and screen it — e.g.
	// http://[64:ff9b::a9fe:a9fe]/ translates to 169.254.169.254 (cloud
	// metadata) without ever resolving a hostname.
	it("blocks IPv4-compatible ::/96 spellings of private addresses", () => {
		for (const addr of [
			"::a9fe:a9fe", // ::169.254.169.254
			"::169.254.169.254", // dotted tail form
			"::7f00:1", // ::127.0.0.1
			"::a00:1", // ::10.0.0.1
			"::c0a8:101", // ::192.168.1.1
			"0:0:0:0:0:0:a9fe:a9fe", // expanded form
		]) {
			expect(isPrivateIpAddress(addr), addr).toBe(true);
		}
		// Public embeds stay public; :: and ::1 were already blocked.
		expect(isPrivateIpAddress("::808:808")).toBe(false); // ::8.8.8.8
		expect(isPrivateIpAddress("::8.8.8.8")).toBe(false);
	});

	it("blocks NAT64 64:ff9b::/96 spellings of private addresses", () => {
		for (const addr of [
			"64:ff9b::a9fe:a9fe", // 169.254.169.254
			"64:ff9b::169.254.169.254", // dotted tail form
			"64:ff9b::7f00:1", // 127.0.0.1
			"64:ff9b::a00:1", // 10.0.0.1
			"64:ff9b::c0a8:101", // 192.168.1.1
			"64:ff9b::ac10:1", // 172.16.0.1
			"64:ff9b::6440:1", // 100.64.0.1 (CGNAT)
			"0064:ff9b:0000:0000:0000:0000:a9fe:a9fe", // expanded form
		]) {
			expect(isPrivateIpAddress(addr), addr).toBe(true);
		}
		expect(isPrivateIpAddress("64:ff9b::808:808")).toBe(false); // 8.8.8.8
		expect(isPrivateIpAddress("64:ff9b::8.8.8.8")).toBe(false);
	});

	it("blocks 6to4 2002::/16 spellings of private addresses", () => {
		for (const addr of [
			"2002:a9fe:a9fe::", // 169.254.169.254
			"2002:7f00:1::", // 127.0.0.1
			"2002:a00:1::", // 10.0.0.1
			"2002:c0a8:101::1", // 192.168.1.1 with subnet host bits
			"2002:ac1f:1::", // 172.31.0.1
		]) {
			expect(isPrivateIpAddress(addr), addr).toBe(true);
		}
		expect(isPrivateIpAddress("2002:808:808::")).toBe(false); // 8.8.8.8
		expect(isPrivateIpAddress("2002:cb00:710a::")).toBe(false); // 203.0.113.10
	});

	it("blocks Teredo 2001:0000::/32 spellings of private addresses", () => {
		// Teredo obfuscates the client IPv4 as the low 32 bits XOR 0xffffffff.
		for (const addr of [
			"2001:0:4136:e378:8000:63bf:5601:5601", // client 169.254.169.254
			"2001:0::80ff:fffe", // client 127.0.0.1
			"2001:0:4136:e378:8000:63bf:f5ff:fffe", // client 10.0.0.1
		]) {
			expect(isPrivateIpAddress(addr), addr).toBe(true);
		}
		// Client 192.0.2.45 (TEST-NET-1) is outside every blocked IPv4 range.
		expect(isPrivateIpAddress("2001:0:4136:e378:8000:63bf:3fff:fdd2")).toBe(
			false,
		);
		// Other 2001:: space (non-Teredo) is unaffected.
		expect(isPrivateIpAddress("2001:4860:4860::8888")).toBe(false);
	});

	it("screens bracketed URL-literal forms end to end", () => {
		expect(isPrivateIpAddress("[64:ff9b::a9fe:a9fe]")).toBe(true);
		expect(isPrivateIpAddress("[2002:a9fe:a9fe::]")).toBe(true);
		expect(isPrivateIpAddress("[::a9fe:a9fe]")).toBe(true);
	});

	it("still allows legitimate public IPv6 in the screened prefixes", () => {
		expect(isPrivateIpAddress("64:ff9b:1::a9fe:a9fe")).toBe(false); // not /96
		expect(isPrivateIpAddress("2001:db8::1")).toBe(false); // docs range, non-Teredo
		expect(isPrivateIpAddress("2003:a9fe:a9fe::")).toBe(false); // not 6to4
	});

	it("blocks mixed-case and non-canonical spellings of the same embeds", () => {
		for (const addr of [
			"64:FF9B::A9FE:A9FE", // upper-case NAT64
			"2002:A9FE:A9FE::", // upper-case 6to4
			"2001:0:4136:E378:8000:63BF:5601:5601", // upper-case Teredo
			"0::ffff:7f00:1", // mapped spelling the normalize prefix regex misses
			"0:0:0:0:0:ffff:7f00:1", // expanded mapped loopback
			"0:0:0:0:0:0:7f00:1", // expanded compatible loopback
			"0:0:0:0:0:0:0:1", // expanded ::1
			"0:0:0:0:0:0:0:0", // expanded ::
		]) {
			expect(isPrivateIpAddress(addr), addr).toBe(true);
		}
	});

	it("screens zone-id and mapped loopback literals end to end", () => {
		expect(isPrivateIpAddress("fe80::1%eth0")).toBe(true);
		expect(isPrivateIpAddress("[fe80::1%25eth0]")).toBe(true);
		expect(isPrivateIpAddress("[::ffff:7f00:1]")).toBe(true);
	});

	it("loose URL spellings are unparseable or canonicalize into the guard", () => {
		// Node and Bun both REJECT a loose dotted tail inside an IPv6 literal
		// (leading-zero octal / hex quads), so those spellings can never be
		// connected to — the strict dotted-tail parse in the guard is no bypass.
		for (const url of [
			"http://[64:ff9b::0177.0.0.1]/",
			"http://[64:ff9b::0xa9.0xfe.0xa9.0xfe]/",
			"http://[::ffff:2130706433]/",
		]) {
			expect(() => new URL(url), url).toThrow();
		}
		// Mixed-case spellings DO parse and canonicalize; the canonical form is
		// what reaches isPrivateIpAddress, and it stays blocked.
		expect(new URL("http://[::FFFF:7F00:1]/").hostname).toBe("[::ffff:7f00:1]");
		expect(
			isPrivateIpAddress(new URL("http://[64:FF9B::A9FE:A9FE]/").hostname),
		).toBe(true);
	});
});
