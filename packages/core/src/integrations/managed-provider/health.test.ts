/**
 * Exercises probeProviderHealth, the connection-health translator that turns
 * adapter failures into typed ProviderHealthSnapshot states, against
 * deterministic seams: the real guarded client over an injected transport, and
 * direct taxonomy errors for switch arms the HTTP layer cannot produce
 * deterministically. No network access occurs.
 */

import { describe, expect, it } from "vitest";
import { probeProviderHealth } from "./health";
import {
	ManagedProviderError,
	ManagedProviderHttpClient,
	resolveProviderConnection,
} from "./index";

function managedClient(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	options: { timeoutMs?: number } = {},
): ManagedProviderHttpClient {
	return new ManagedProviderHttpClient({
		connection: resolveProviderConnection({
			mode: "managed",
			providerId: "linear",
			connectionId: "conn_0123456789abcdef",
			gatewayBaseUrl: "https://gateway.example.test",
		}),
		testTransport: {
			fetchImpl: fetchImpl as unknown as typeof fetch,
		},
		...options,
	});
}

function failingClient(error: unknown): ManagedProviderHttpClient {
	return {
		url: (path: string) => new URL(path, "https://gateway.example.test"),
		requestJson: () => Promise.reject(error),
	} as unknown as ManagedProviderHttpClient;
}

describe("probeProviderHealth", () => {
	it("probes /health on the pinned origin by default", async () => {
		const requestedUrls: string[] = [];
		const client = managedClient(async (url: string) => {
			requestedUrls.push(url);
			return Response.json({ ok: true });
		});
		const snapshot = await probeProviderHealth(client);
		expect(snapshot.state).toBe("healthy");
		expect(snapshot.code).toBeNull();
		expect(requestedUrls).toHaveLength(1);
		expect(new URL(requestedUrls[0]).pathname).toBe("/health");
		expect(new URL(requestedUrls[0]).origin).toBe(
			"https://gateway.example.test",
		);
	});

	it("forwards a custom probe path to the transport", async () => {
		const requestedUrls: string[] = [];
		const client = managedClient(async (url: string) => {
			requestedUrls.push(url);
			return Response.json({ ok: true });
		});
		await probeProviderHealth(client, "/v1/status");
		expect(new URL(requestedUrls[0]).pathname).toBe("/v1/status");
	});

	it("stamps healthy snapshots with an ISO checkedAt and a non-negative latency", async () => {
		const client = managedClient(async () => Response.json({ ok: true }));
		const snapshot = await probeProviderHealth(client);
		expect(Number.isNaN(Date.parse(snapshot.checkedAt))).toBe(false);
		expect(typeof snapshot.latencyMs).toBe("number");
		expect(snapshot.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("reports rate_limited with the provider retry-after translated to milliseconds", async () => {
		const client = managedClient(
			async () =>
				new Response("slow", {
					status: 429,
					headers: { "retry-after": "2" },
				}),
		);
		const snapshot = await probeProviderHealth(client);
		expect(snapshot.state).toBe("rate_limited");
		expect(snapshot.code).toBe("RATE_LIMITED");
		expect(snapshot.retryAfterMs).toBe(2000);
		expect(Number.isNaN(Date.parse(snapshot.checkedAt))).toBe(false);
	});

	it("maps timeout, network, and endpoint-blocked failures onto unreachable", async () => {
		const codes = [
			"PROVIDER_TIMEOUT",
			"PROVIDER_NETWORK",
			"ENDPOINT_BLOCKED",
		] as const;
		for (const code of codes) {
			const client = failingClient(
				new ManagedProviderError(`${code} during probe`, { code }),
			);
			const snapshot = await probeProviderHealth(client);
			expect(snapshot.state).toBe("unreachable");
			expect(snapshot.code).toBe(code);
			expect(snapshot.latencyMs).toBeGreaterThanOrEqual(0);
		}
	});

	it("falls back to degraded for adapter errors outside the dedicated arms", async () => {
		const client = failingClient(
			new ManagedProviderError("bad input during probe", {
				code: "INVALID_INPUT",
			}),
		);
		const snapshot = await probeProviderHealth(client);
		expect(snapshot.state).toBe("degraded");
		expect(snapshot.code).toBe("INVALID_INPUT");
	});

	it("carries the provider retry delay on unreachable snapshots too", async () => {
		const client = failingClient(
			new ManagedProviderError("blocked with retry hint", {
				code: "ENDPOINT_BLOCKED",
				retryAfterMs: 5000,
			}),
		);
		const snapshot = await probeProviderHealth(client);
		expect(snapshot.state).toBe("unreachable");
		expect(snapshot.retryAfterMs).toBe(5000);
	});

	it("rethrows foreign errors instead of inventing a health state", async () => {
		const foreign = new TypeError("transport exploded");
		const client = failingClient(foreign);
		const caught = await probeProviderHealth(client).then(
			() => null,
			(error: unknown) => error,
		);
		expect(caught).toBe(foreign);
	});
});
