/**
 * Socket-level integration tests for the pinned SSRF transport.
 *
 * These use a REAL local HTTP server and the REAL node:http pinned transport
 * (`nodePinnedFetch`) — no mocked plumbing. The fake `.test` hostnames do not
 * exist in any resolver, so a successful request proves the connection was
 * routed through the pinned lookup to 127.0.0.1 at the socket level.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchWithSsrfGuard } from "./fetch-guard.ts";
import { nodePinnedFetch } from "./node-pinned-fetch.ts";
import { type LookupFn, SsrfBlockedError } from "./ssrf.ts";

describe("pinned fetch through a real local HTTP server", () => {
	let server: Server;
	let port: number;
	const seenRequests: Array<{ host: string | undefined; url: string }> = [];

	beforeAll(async () => {
		server = createServer((req, res) => {
			seenRequests.push({ host: req.headers.host, url: req.url ?? "" });
			if (req.url === "/redirect-to-rebound") {
				res.statusCode = 302;
				res.setHeader("location", `http://rebound.example.test:${port}/steal`);
				res.end();
				return;
			}
			res.statusCode = 200;
			res.setHeader("content-type", "text/plain");
			res.end(`hello from ${req.url}`);
		});
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		);
	});

	it("connects to 127.0.0.1 via the pinned lookup for a fake hostname (real socket)", async () => {
		let lookupCalls = 0;
		const lookupFn: LookupFn = async (hostname) => {
			lookupCalls += 1;
			expect(hostname).toBe("pinned.example.test");
			return [{ address: "127.0.0.1", family: 4 }];
		};

		const { response, finalUrl, release } = await fetchWithSsrfGuard({
			url: `http://pinned.example.test:${port}/hello`,
			lookupFn,
			pinnedFetchImpl: nodePinnedFetch,
			// 127.0.0.1 is private: the resolved-address check must be explicitly
			// allowlisted for this hostname, mirroring a real internal allowlist.
			policy: { allowedHostnames: ["pinned.example.test"] },
			timeoutMs: 5000,
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("hello from /hello");
		expect(finalUrl).toBe(`http://pinned.example.test:${port}/hello`);
		// Exactly one resolution — the transport reused the pinned addresses.
		expect(lookupCalls).toBe(1);
		// The server saw the original Host header, proving the request targeted
		// the fake hostname while the socket went to the pinned 127.0.0.1.
		const request = seenRequests.find((entry) => entry.url === "/hello");
		expect(request?.host).toBe(`pinned.example.test:${port}`);
		await release();
	});

	it("blocks a rebinding flip: second resolution of the same hostname returns a private IP", async () => {
		const requestsBefore = seenRequests.length;
		let resolutions = 0;
		const lookupFn: LookupFn = async () => {
			resolutions += 1;
			// First resolution: a public address (what the attacker's DNS serves
			// while the URL is being vetted). Second resolution: flipped to a
			// private target — the classic rebinding move.
			return resolutions === 1
				? [{ address: "203.0.113.10", family: 4 }]
				: [{ address: "169.254.169.254", family: 4 }];
		};

		// First guarded fetch pins 203.0.113.10 (TEST-NET, unroutable) — abort it
		// fast; the point is the resolution was accepted and pinned.
		await expect(
			fetchWithSsrfGuard({
				url: `http://rebind.example.test:${port}/first`,
				lookupFn,
				pinnedFetchImpl: nodePinnedFetch,
				timeoutMs: 250,
			}),
		).rejects.toThrow();
		expect(resolutions).toBe(1);

		// Second guarded fetch re-resolves; DNS now serves the private metadata
		// IP. The guard must block BEFORE any socket is opened.
		await expect(
			fetchWithSsrfGuard({
				url: `http://rebind.example.test:${port}/second`,
				lookupFn,
				pinnedFetchImpl: nodePinnedFetch,
				timeoutMs: 5000,
			}),
		).rejects.toBeInstanceOf(SsrfBlockedError);
		expect(resolutions).toBe(2);
		// No request ever reached the local server for either attempt.
		expect(seenRequests.length).toBe(requestsBefore);
	});

	it("blocks a redirect hop whose hostname resolves to a private IP (through the real transport)", async () => {
		const lookupFn: LookupFn = async (hostname) => {
			if (hostname === "pinned.example.test") {
				return [{ address: "127.0.0.1", family: 4 }];
			}
			// The redirect target "rebound.example.test" resolves to a private IP.
			return [{ address: "10.0.0.1", family: 4 }];
		};

		await expect(
			fetchWithSsrfGuard({
				url: `http://pinned.example.test:${port}/redirect-to-rebound`,
				lookupFn,
				pinnedFetchImpl: nodePinnedFetch,
				policy: { allowedHostnames: ["pinned.example.test"] },
				timeoutMs: 5000,
			}),
		).rejects.toBeInstanceOf(SsrfBlockedError);

		// The first hop really hit the server; the rebound hop never did.
		const firstHop = seenRequests.filter(
			(entry) => entry.url === "/redirect-to-rebound",
		);
		expect(firstHop.length).toBe(1);
		expect(seenRequests.some((entry) => entry.url === "/steal")).toBe(false);
	});
});
