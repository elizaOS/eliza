/**
 * Unit suite for the @elizaos/core/network public entry (network/index.ts),
 * driven exactly as subpath consumers drive it: policy normalization, loopback
 * and blocked-hostname classification, fail-closed resolution inputs, the
 * pinned-lookup contract handed to transports, guarded-fetch literal
 * screening, and the pinned transport's abort wiring. Deterministic — stub
 * lookupFn/fetchImpl collaborators only, never the module under test.
 */
import { describe, expect, it } from "vitest";
import {
	assertPublicHostname,
	createPinnedLookup,
	fetchWithSsrfGuard,
	isBlockedHostname,
	isLoopbackHost,
	isPrivateIpAddress,
	type LookupFn,
	nodePinnedFetch,
	normalizeHostLike,
	normalizeIpForPolicy,
	resolvePinnedHostname,
	resolvePinnedHostnameWithPolicy,
	SsrfBlockedError,
} from "./index.ts";

function serveSingle(
	lookup: ReturnType<typeof createPinnedLookup>,
	hostname: string,
	callback: (error: Error | null, address: string, family?: number) => void,
): void {
	lookup(hostname, callback);
}

describe("network barrel: IP policy normalization", () => {
	it("maps bracketed, scoped, and IPv4-mapped spellings onto canonical dotted quads", () => {
		expect(normalizeIpForPolicy("  [::FFFF:127.0.0.1] ")).toBe("127.0.0.1");
		expect(normalizeIpForPolicy("::ffff:7f00:1")).toBe("127.0.0.1");
		expect(normalizeIpForPolicy("0:0:0:0:0:ffff:c000:201")).toBe("192.0.2.1");
		expect(normalizeIpForPolicy("fe80::1%eth0")).toBe("fe80::1");
	});

	it("leaves non-mapped hosts untouched apart from casing and the trailing dot", () => {
		expect(normalizeIpForPolicy("EXAMPLE.com.")).toBe("example.com");
		expect(normalizeIpForPolicy("2001:db8::1")).toBe("2001:db8::1");
		expect(normalizeIpForPolicy("8.8.8.8")).toBe("8.8.8.8");
		expect(normalizeIpForPolicy("")).toBe("");
	});

	it("exposes host normalization to policy consumers", () => {
		expect(normalizeHostLike(" Example.ORG. ")).toBe("example.org");
		// Bracket stripping runs after the trailing-dot regex, so a dot INSIDE
		// brackets survives normalization.
		expect(normalizeHostLike("[Example.COM.]")).toBe("example.com.");
	});
});

describe("network barrel: loopback and blocked-hostname classification", () => {
	it("recognizes canonical, bracketed, trailing-dot, and non-canonical loopback encodings", () => {
		expect(isLoopbackHost("localhost")).toBe(true);
		expect(isLoopbackHost("localhost.")).toBe(true);
		expect(isLoopbackHost("[::1]")).toBe(true);
		expect(isLoopbackHost("2130706433")).toBe(true);
		expect(isLoopbackHost("0177.0.0.1")).toBe(true);
		expect(isLoopbackHost("::ffff:7f00:1")).toBe(true);
	});

	it("classifies non-loopback and malformed strings as not loopback", () => {
		expect(isLoopbackHost("128.0.0.1")).toBe(false);
		expect(isLoopbackHost("::2")).toBe(false);
		expect(isLoopbackHost("example.com")).toBe(false);
		expect(isLoopbackHost("")).toBe(false);
	});

	it("keeps the blocked-hostname list aligned with normalization", () => {
		expect(isBlockedHostname("[LOCALHOST]")).toBe(true);
		expect(isBlockedHostname("service.internal.")).toBe(true);
		expect(isBlockedHostname("metadata.google.internal")).toBe(true);
	});

	it("still screens plain private literals through the barrel", () => {
		expect(isPrivateIpAddress("10.0.0.7")).toBe(true);
		expect(isPrivateIpAddress("203.0.113.10")).toBe(false);
	});
});

describe("network barrel: SsrfBlockedError identity", () => {
	it("is an Error subclass callers can discriminate by name", () => {
		const error = new SsrfBlockedError("Blocked: unit fixture");
		expect(error).toBeInstanceOf(SsrfBlockedError);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("SsrfBlockedError");
		expect(error.message).toBe("Blocked: unit fixture");
	});
});

describe("network barrel: resolvePinnedHostnameWithPolicy input validation", () => {
	const publicLookup: LookupFn = async () => [
		{ address: "203.0.113.10", family: 4 },
	];

	it("rejects empty and whitespace-only hostnames before any lookup", async () => {
		await expect(
			resolvePinnedHostnameWithPolicy("", { lookupFn: publicLookup }),
		).rejects.toThrow("Invalid hostname");
		await expect(
			resolvePinnedHostnameWithPolicy("   ", { lookupFn: publicLookup }),
		).rejects.toThrow("Invalid hostname");
	});

	it("refuses to resolve without a lookupFn in environment-agnostic core", async () => {
		await expect(
			resolvePinnedHostnameWithPolicy("example.com"),
		).rejects.toThrow(/lookupFn is required/);
	});

	it("admits literal private resolutions only under allowPrivateNetwork", async () => {
		const privateLookup: LookupFn = async () => [
			{ address: "10.0.0.7", family: 4 },
		];
		await expect(
			resolvePinnedHostnameWithPolicy("internal.example", {
				lookupFn: privateLookup,
			}),
		).rejects.toBeInstanceOf(SsrfBlockedError);

		const pinned = await resolvePinnedHostnameWithPolicy("internal.example", {
			lookupFn: privateLookup,
			policy: { allowPrivateNetwork: true },
		});
		expect(pinned.hostname).toBe("internal.example");
		expect(pinned.addresses).toEqual(["10.0.0.7"]);
	});

	it("deduplicates resolver answers while preserving first-seen order", async () => {
		const duplicatedLookup: LookupFn = async () => [
			{ address: "203.0.113.10", family: 4 },
			{ address: "203.0.113.10", family: 4 },
			{ address: "198.51.100.5", family: 4 },
		];
		const pinned = await resolvePinnedHostnameWithPolicy("example.com", {
			lookupFn: duplicatedLookup,
		});
		expect(pinned.addresses).toEqual(["203.0.113.10", "198.51.100.5"]);
	});

	it("honors allowlist entries written in non-canonical form", async () => {
		const metadataLookup: LookupFn = async () => [
			{ address: "169.254.169.254", family: 4 },
		];
		const pinned = await resolvePinnedHostnameWithPolicy(
			"METADATA.GOOGLE.internal.",
			{
				lookupFn: metadataLookup,
				policy: { allowedHostnames: ["metadata.google.internal"] },
			},
		);
		expect(pinned.addresses).toEqual(["169.254.169.254"]);
	});
});

describe("network barrel: legacy wrappers share the policy core", () => {
	it("resolvePinnedHostname blocks internal targets before DNS runs", async () => {
		const mustNotRun: LookupFn = async () => {
			throw new Error("lookup must not run for blocked hosts");
		};
		await expect(
			resolvePinnedHostname("localhost.", mustNotRun),
		).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("assertPublicHostname accepts public resolutions and rejects private ones", async () => {
		await expect(
			assertPublicHostname("example.com", async () => [
				{ address: "203.0.113.10", family: 4 },
			]),
		).resolves.toBeUndefined();

		await expect(
			assertPublicHostname("example.org", async () => [
				{ address: "10.1.2.3", family: 4 },
			]),
		).rejects.toBeInstanceOf(SsrfBlockedError);
	});
});

describe("network barrel: pinned-lookup contract handed to transports", () => {
	it("rotates across every pinned address on successive single lookups", async () => {
		const lookup = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10", "198.51.100.5"],
		});
		const seen: string[] = [];
		for (let i = 0; i < 4; i++) {
			await new Promise<void>((resolve, reject) => {
				serveSingle(lookup, "example.com", (error, address) => {
					if (error) {
						reject(error);
						return;
					}
					seen.push(address);
					resolve();
				});
			});
		}
		expect(seen).toEqual([
			"203.0.113.10",
			"198.51.100.5",
			"203.0.113.10",
			"198.51.100.5",
		]);
	});

	it("serves the complete record list for all-address requests", async () => {
		const lookup = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10", "198.51.100.5"],
		});
		await new Promise<void>((resolve, reject) => {
			lookup("example.com", { all: true }, (error, addresses) => {
				if (error) {
					reject(error);
					return;
				}
				expect(addresses).toEqual([
					{ address: "203.0.113.10", family: 4 },
					{ address: "198.51.100.5", family: 4 },
				]);
				resolve();
			});
		});
	});

	it("filters to the requested family and falls back when none match", async () => {
		const dual = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10", "2001:db8::5"],
		});
		await new Promise<void>((resolve, reject) => {
			dual("example.com", { family: 6 }, (error, address, family) => {
				if (error) {
					reject(error);
					return;
				}
				expect(address).toBe("2001:db8::5");
				expect(family).toBe(6);
				resolve();
			});
		});

		const ipv4Only = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10"],
		});
		await new Promise<void>((resolve, reject) => {
			ipv4Only("example.com", { family: 6 }, (error, address, family) => {
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

	it("accepts bracketed and mixed-case spellings of the pinned host", async () => {
		const lookup = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10"],
		});
		await new Promise<void>((resolve, reject) => {
			serveSingle(lookup, "[Example.Com]", (error, address) => {
				if (error) {
					reject(error);
					return;
				}
				expect(address).toBe("203.0.113.10");
				resolve();
			});
		});
	});

	it("throws for foreign hostnames when no fallback exists", () => {
		const lookup = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10"],
		});
		expect(() => lookup("evil.example", () => {})).toThrow(
			"DNS Context restricted: fallback missing.",
		);
	});

	it("delegates foreign hostnames to a real fallback lookup in both shapes", async () => {
		const fallback = createPinnedLookup({
			hostname: "fallback.example",
			addresses: ["198.51.100.9"],
		});
		const composed = createPinnedLookup({
			hostname: "example.com",
			addresses: ["203.0.113.10"],
			fallback,
		});

		await new Promise<void>((resolve, reject) => {
			composed("Fallback.Example.", (error, address, family) => {
				if (error) {
					reject(error);
					return;
				}
				expect(address).toBe("198.51.100.9");
				expect(family).toBe(4);
				resolve();
			});
		});

		await new Promise<void>((resolve, reject) => {
			composed("fallback.example", { all: true }, (error, addresses) => {
				if (error) {
					reject(error);
					return;
				}
				expect(addresses).toEqual([{ address: "198.51.100.9", family: 4 }]);
				resolve();
			});
		});
	});
});

describe("network barrel: fetchWithSsrfGuard literal screening", () => {
	const refusingFetch = async (): Promise<Response> => {
		throw new Error("guard must not dispatch to screened targets");
	};

	it("rejects literal private targets before dispatching", async () => {
		await expect(
			fetchWithSsrfGuard({
				url: "http://169.254.169.254/computeMetadata/v1/",
				fetchImpl: refusingFetch,
			}),
		).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("rejects blocked internal hostnames before dispatching", async () => {
		await expect(
			fetchWithSsrfGuard({
				url: "https://metadata.google.internal/",
				fetchImpl: refusingFetch,
			}),
		).rejects.toBeInstanceOf(SsrfBlockedError);
	});

	it("rejects non-http(s) protocols outright", async () => {
		await expect(
			fetchWithSsrfGuard({
				url: "file:///etc/hosts",
				fetchImpl: refusingFetch,
			}),
		).rejects.toThrow("Invalid URL: must be http or https");
	});

	it("returns the guarded response plus a release handle for public URLs", async () => {
		const result = await fetchWithSsrfGuard({
			url: "https://example.com/page",
			fetchImpl: async () => new Response("ok", { status: 200 }),
		});
		expect(result.finalUrl).toBe("https://example.com/page");
		expect(result.response.status).toBe(200);
		await result.release();
	});
});

describe("network barrel: nodePinnedFetch abort wiring", () => {
	it("rejects immediately when the caller's signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			nodePinnedFetch({
				url: new URL("http://127.0.0.1:9/never"),
				init: { signal: controller.signal },
				lookup: () => {},
				addresses: [],
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});
