/**
 * The mobile agent (musl Bun on Android, no /etc/resolv.conf) replaces
 * `dns.lookup` and `dns.promises.lookup` at boot with a resolver that asks
 * explicit nameservers. A bundled agent links `node:dns/promises` before that
 * replacement runs, so a named `lookup` import keeps the system resolver: on
 * the phone every guarded fetch (Eliza Cloud Maps routes, 2026-11-18) waited
 * out musl's 5 s DNS timeout and failed as PROVIDER_NETWORK. The guard's
 * default lookups must read the replaced resolver at call time.
 */

// Linked first on purpose, as in the bundle: the namespace exists before the patch.
import "node:dns/promises";
import dns from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWithSsrfGuard } from "../src/network/fetch-guard";
import {
	createValidatedLookup,
	nodeLookupFn,
} from "../src/network/node-pinned-fetch";

const originalPromiseLookup = dns.promises.lookup;
const originalLookup = dns.lookup;
let server: Server | undefined;

afterEach(async () => {
	dns.promises.lookup = originalPromiseLookup;
	dns.lookup = originalLookup;
	await new Promise<void>((resolve) =>
		server ? server.close(() => resolve()) : resolve(),
	);
	server = undefined;
});

/** What configureMobileDnsIfNeeded installs, reduced to a fixed answer. */
function replaceResolver(address: string) {
	const seen: string[] = [];
	dns.promises.lookup = (async (hostname: string) => {
		seen.push(hostname);
		return [{ address, family: 4 }];
	}) as typeof dns.promises.lookup;
	dns.lookup = ((
		hostname: string,
		_options: unknown,
		callback: (
			error: null,
			addresses: { address: string; family: number }[],
		) => void,
	) => {
		seen.push(hostname);
		callback(null, [{ address, family: 4 }]);
	}) as unknown as typeof dns.lookup;
	return seen;
}

describe("guarded fetch uses the runtime's current DNS resolver", () => {
	it("resolves through a dns.promises.lookup installed after import", async () => {
		const seen = replaceResolver("203.0.113.7");
		await expect(
			nodeLookupFn("maps.example.com", { all: true }),
		).resolves.toEqual([{ address: "203.0.113.7", family: 4 }]);
		expect(seen).toEqual(["maps.example.com"]);
	});

	it("validates connect-time candidates from a dns.lookup installed after import", async () => {
		const seen = replaceResolver("8.8.4.4");
		const lookup = createValidatedLookup(() => {});
		const addresses = await new Promise((resolve, reject) =>
			lookup("maps.example.com", { all: true }, (error, result) =>
				error ? reject(error) : resolve(result),
			),
		);
		expect(addresses).toEqual([{ address: "8.8.4.4", family: 4 }]);
		expect(seen).toEqual(["maps.example.com"]);
	});

	it("reaches the host the replaced resolver names, end to end", async () => {
		server = createServer((request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ host: request.headers.host }));
		});
		await new Promise<void>((resolve) =>
			server?.listen(0, "127.0.0.1", resolve),
		);
		const { port } = server.address() as AddressInfo;
		const seen = replaceResolver("127.0.0.1");
		const result = await fetchWithSsrfGuard({
			url: `http://maps.example.com:${port}/api/v1/maps/routes`,
			timeoutMs: 5_000,
			policy: { allowPrivateNetwork: true },
		});
		try {
			expect(await result.response.json()).toEqual({
				host: `maps.example.com:${port}`,
			});
		} finally {
			await result.release();
		}
		expect(seen).toContain("maps.example.com");
	});
});
