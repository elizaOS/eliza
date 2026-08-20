/**
 * Exercises the managed-provider adapter SDK against deterministic
 * protocol-faithful fake transports: connection resolution for managed and
 * local modes, the guarded HTTP client's success/auth/rate-limit/malformed/
 * oversize/timeout classification, pagination ceilings and cursor-loop
 * rejection, and health probing. The transport seam is injected; no network
 * access occurs.
 */

import { describe, expect, it, vi } from "vitest";
import {
	collectProviderPages,
	isOpaqueConnectionId,
	ManagedProviderError,
	ManagedProviderHttpClient,
	type ProviderResponseSchema,
	probeProviderHealth,
	resolveProviderConnection,
	toCapabilityExecutionErrorCode,
} from "./index";

const itemsSchema: ProviderResponseSchema<{ items: string[] }> = {
	safeParse(value: unknown) {
		if (
			value !== null &&
			typeof value === "object" &&
			Array.isArray((value as { items?: unknown }).items) &&
			(value as { items: unknown[] }).items.every(
				(item) => typeof item === "string",
			)
		) {
			return { success: true, data: value as { items: string[] } };
		}
		return { success: false, error: new Error("items contract violated") };
	},
};

function managedClient(
	fetchImpl: (url: string, init?: RequestInit) => Promise<Response>,
	options: { timeoutMs?: number; responseByteLimit?: number } = {},
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

describe("resolveProviderConnection", () => {
	it("resolves managed mode to the gateway origin without any credential", () => {
		const connection = resolveProviderConnection({
			mode: "managed",
			providerId: "linear",
			connectionId: "conn_0123456789abcdef",
			gatewayBaseUrl: "https://gateway.example.test",
		});
		expect(connection).toMatchObject({
			mode: "managed",
			providerId: "linear",
			connectionId: "conn_0123456789abcdef",
			baseOrigin: "https://gateway.example.test",
		});
		expect(connection.credential).toBeUndefined();
	});

	it("resolves local mode with the explicit credential and a derived opaque id", () => {
		const connection = resolveProviderConnection({
			mode: "local",
			providerId: "linear",
			baseUrl: "https://api.linear.example.test",
			credential: "byo-secret",
		});
		expect(connection.mode).toBe("local");
		expect(connection.credential).toBe("byo-secret");
		expect(isOpaqueConnectionId(connection.connectionId)).toBe(true);
		expect(connection.connectionId).not.toContain("byo-secret");
		expect(connection.connectionId).not.toContain("example.test");
	});

	it("rejects non-opaque managed connection ids and malformed endpoints", () => {
		expect(() =>
			resolveProviderConnection({
				mode: "managed",
				providerId: "linear",
				connectionId: "provider-account-42",
				gatewayBaseUrl: "https://gateway.example.test",
			}),
		).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
		for (const gatewayBaseUrl of [
			"not a url",
			"https://gateway.example.test/v1",
			"https://user:pw@gateway.example.test",
			"https://gateway.example.test/?key=abc",
		]) {
			expect(() =>
				resolveProviderConnection({
					mode: "managed",
					providerId: "linear",
					connectionId: "conn_0123456789abcdef",
					gatewayBaseUrl,
				}),
			).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
		}
		expect(() =>
			resolveProviderConnection({
				mode: "local",
				providerId: "linear",
				baseUrl: "https://api.example.test",
				credential: "",
			}),
		).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
	});
});

describe("ManagedProviderHttpClient", () => {
	it("pins requests to the resolved origin and propagates the connection id header", async () => {
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("x-eliza-connection-id")).toBe(
				"conn_0123456789abcdef",
			);
			expect(headers.get("authorization")).toBeNull();
			return Response.json({ items: ["a"] });
		});
		const client = managedClient(fetchImpl);
		await expect(
			client.requestJson(client.url("/items"), { method: "GET" }, itemsSchema),
		).resolves.toEqual({ items: ["a"] });
		expect(() => client.url("https://elsewhere.example.test/items")).toThrow(
			expect.objectContaining({ code: "ENDPOINT_BLOCKED" }),
		);
	});

	it("sends the local credential as a bearer token", async () => {
		const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			expect(headers.get("authorization")).toBe("Bearer byo-secret");
			return Response.json({ items: [] });
		});
		const client = new ManagedProviderHttpClient({
			connection: resolveProviderConnection({
				mode: "local",
				providerId: "linear",
				baseUrl: "https://api.linear.example.test",
				credential: "byo-secret",
			}),
			testTransport: { fetchImpl: fetchImpl as unknown as typeof fetch },
		});
		await expect(
			client.requestJson(client.url("/items"), { method: "GET" }, itemsSchema),
		).resolves.toEqual({ items: [] });
	});

	it("classifies expired, revoked, rate-limited, and failed upstream responses", async () => {
		const cases: Array<{
			response: Response;
			code: string;
			retryAfterMs?: number;
		}> = [
			{
				response: Response.json(
					{ code: "credential_expired" },
					{ status: 401 },
				),
				code: "AUTH_EXPIRED",
			},
			{
				response: Response.json(
					{ code: "credential_revoked" },
					{ status: 403 },
				),
				code: "AUTH_REVOKED",
			},
			{
				response: new Response("slow down", {
					status: 429,
					headers: { "retry-after": "2" },
				}),
				code: "RATE_LIMITED",
				retryAfterMs: 2_000,
			},
			{
				response: new Response("boom", { status: 502 }),
				code: "PROVIDER_FAILURE",
			},
			{
				response: new Response("nope", { status: 422 }),
				code: "PROVIDER_REJECTED",
			},
		];
		for (const testCase of cases) {
			const client = managedClient(async () => testCase.response);
			const failure = await client
				.requestJson(client.url("/items"), { method: "GET" }, itemsSchema)
				.then(
					() => null,
					(error: unknown) => error,
				);
			expect(failure).toBeInstanceOf(ManagedProviderError);
			expect(failure).toMatchObject({ code: testCase.code });
			if (testCase.retryAfterMs !== undefined) {
				expect(failure).toMatchObject({ retryAfterMs: testCase.retryAfterMs });
			}
		}
	});

	it("rejects malformed JSON and contract-violating bodies without leaking them", async () => {
		const malformed = managedClient(async () => new Response("<html>oops"));
		const malformedFailure = await malformed
			.requestJson(malformed.url("/items"), { method: "GET" }, itemsSchema)
			.then(
				() => null,
				(error: unknown) => error,
			);
		expect(malformedFailure).toMatchObject({ code: "MALFORMED_RESPONSE" });
		expect((malformedFailure as Error).message).not.toContain("<html>");

		const drifted = managedClient(async () => Response.json({ items: [42] }));
		await expect(
			drifted.requestJson(
				drifted.url("/items"),
				{ method: "GET" },
				itemsSchema,
			),
		).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
	});

	it("enforces the response byte limit for declared and streamed bodies", async () => {
		const big = "x".repeat(2_048);
		const client = managedClient(
			async () => new Response(JSON.stringify({ items: [big] })),
			{ responseByteLimit: 1_024 },
		);
		await expect(
			client.requestJson(client.url("/items"), { method: "GET" }, itemsSchema),
		).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
	});

	it("classifies transport timeouts as PROVIDER_TIMEOUT", async () => {
		const client = managedClient(
			(_url: string, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("aborted", "AbortError")),
					);
				}),
			{ timeoutMs: 100 },
		);
		await expect(
			client.requestJson(client.url("/items"), { method: "GET" }, itemsSchema),
		).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
	});

	it("treats 404 as designed-null only on the optional path", async () => {
		const notFound = async () => new Response("missing", { status: 404 });
		const client = managedClient(notFound);
		await expect(
			client.requestOptionalJson(
				client.url("/items/nope"),
				{ method: "GET" },
				itemsSchema,
			),
		).resolves.toBeNull();
		const strict = managedClient(notFound);
		await expect(
			strict.requestJson(
				strict.url("/items/nope"),
				{ method: "GET" },
				itemsSchema,
			),
		).rejects.toMatchObject({ code: "PROVIDER_REJECTED" });
	});

	it("rejects private, blocked, and plain-HTTP origins outside the test seam", () => {
		expect(
			() =>
				new ManagedProviderHttpClient({
					connection: resolveProviderConnection({
						mode: "local",
						providerId: "linear",
						baseUrl: "https://169.254.169.254",
					}),
				}),
		).toThrowError(expect.objectContaining({ code: "ENDPOINT_BLOCKED" }));
		expect(
			() =>
				new ManagedProviderHttpClient({
					connection: resolveProviderConnection({
						mode: "local",
						providerId: "linear",
						baseUrl: "http://api.example.test",
					}),
				}),
		).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
		expect(
			() =>
				new ManagedProviderHttpClient({
					connection: resolveProviderConnection({
						mode: "local",
						providerId: "linear",
						baseUrl: "https://api.example.test",
					}),
					allowPrivateNetworkForTests: true,
				}),
		).toThrowError(expect.objectContaining({ code: "INVALID_INPUT" }));
	});
});

describe("collectProviderPages", () => {
	it("drains pages until the provider reports completion", async () => {
		const pages = [
			{ items: ["a", "b"], nextCursor: "c1" },
			{ items: ["c"], nextCursor: "c2" },
			{ items: ["d"], nextCursor: null },
		];
		const seen: Array<string | undefined> = [];
		const items = await collectProviderPages(async (cursor) => {
			seen.push(cursor);
			const page = pages.shift();
			if (!page) throw new Error("exhausted fixture");
			return page;
		});
		expect(items).toEqual(["a", "b", "c", "d"]);
		expect(seen).toEqual([undefined, "c1", "c2"]);
	});

	it("returns a designed-empty listing as an empty array", async () => {
		await expect(
			collectProviderPages(async () => ({ items: [], nextCursor: null })),
		).resolves.toEqual([]);
	});

	it("rejects cursor loops, empty cursors, and limit overflows", async () => {
		await expect(
			collectProviderPages(async () => ({ items: ["x"], nextCursor: "same" }), {
				maxPages: 10,
			}),
		).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
		await expect(
			collectProviderPages(async () => ({ items: [], nextCursor: "" })),
		).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
		let counter = 0;
		await expect(
			collectProviderPages(
				async () => ({ items: [], nextCursor: `c${counter++}` }),
				{ maxPages: 3 },
			),
		).rejects.toMatchObject({ code: "PAGINATION_OVERFLOW" });
		await expect(
			collectProviderPages(
				async () => ({ items: ["a", "b"], nextCursor: null }),
				{ maxItems: 1 },
			),
		).rejects.toMatchObject({ code: "PAGINATION_OVERFLOW" });
	});
});

describe("probeProviderHealth", () => {
	it("reports healthy with latency on a well-formed health body", async () => {
		const client = managedClient(async () => Response.json({ ok: true }));
		const snapshot = await probeProviderHealth(client);
		expect(snapshot.state).toBe("healthy");
		expect(snapshot.code).toBeNull();
		expect(snapshot.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it("maps the failure taxonomy onto distinct unhealthy states", async () => {
		const cases: Array<{ response: Response; state: string; code: string }> = [
			{
				response: Response.json(
					{ code: "credential_expired" },
					{ status: 401 },
				),
				state: "reauth_required",
				code: "AUTH_EXPIRED",
			},
			{
				response: Response.json(
					{ code: "credential_revoked" },
					{ status: 401 },
				),
				state: "revoked",
				code: "AUTH_REVOKED",
			},
			{
				response: new Response("slow", {
					status: 429,
					headers: { "retry-after": "1" },
				}),
				state: "rate_limited",
				code: "RATE_LIMITED",
			},
			{
				response: new Response("down", { status: 503 }),
				state: "degraded",
				code: "PROVIDER_FAILURE",
			},
		];
		for (const testCase of cases) {
			const client = managedClient(async () => testCase.response);
			await expect(probeProviderHealth(client)).resolves.toMatchObject({
				state: testCase.state,
				code: testCase.code,
			});
		}
	});
});

describe("toCapabilityExecutionErrorCode", () => {
	it("maps every taxonomy code onto the capability execution contract", () => {
		expect(toCapabilityExecutionErrorCode("AUTH_EXPIRED")).toBe(
			"authentication_failed",
		);
		expect(toCapabilityExecutionErrorCode("RATE_LIMITED")).toBe("rate_limited");
		expect(toCapabilityExecutionErrorCode("PROVIDER_TIMEOUT")).toBe("timeout");
		expect(toCapabilityExecutionErrorCode("MALFORMED_RESPONSE")).toBe(
			"schema_drift",
		);
		expect(toCapabilityExecutionErrorCode("INVALID_INPUT")).toBe(
			"invalid_request",
		);
		expect(toCapabilityExecutionErrorCode("PROVIDER_FAILURE")).toBe(
			"provider_error",
		);
	});
});
