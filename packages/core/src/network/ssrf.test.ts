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
