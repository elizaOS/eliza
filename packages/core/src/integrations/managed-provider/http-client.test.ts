/**
 * Exercises the real bounded HTTP client shared by managed-provider adapters:
 * constructor policy validation (credentials, TLS, private networks, header
 * names, timeout and byte ceilings), origin-pinned URL building, auth-header
 * ownership, upstream error classification, designed-null 404s, and the
 * streamed byte-limit / UTF-8 / JSON-schema decode paths. Fully deterministic
 * — every request runs against an in-memory fetch injected through the
 * module's own testTransport seam, with no network or DNS involved; the one
 * wall-clock dependency (HTTP-date Retry-After) is pinned via a Date.now stub.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { SsrfBlockedError } from "../../network";
import {
	type ResolvedProviderConnection,
	resolveProviderConnection,
} from "./connection";
import { ManagedProviderError } from "./errors";
import {
	MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES,
	MANAGED_PROVIDER_DEFAULT_TIMEOUT_MS,
	MANAGED_PROVIDER_MAX_RESPONSE_BYTES,
	MANAGED_PROVIDER_MAX_TIMEOUT_MS,
	MANAGED_PROVIDER_MIN_TIMEOUT_MS,
	ManagedProviderHttpClient,
	type ProviderResponseSchema,
} from "./http-client";

afterEach(() => {
	vi.restoreAllMocks();
});

const PUBLIC_ORIGIN = "https://api.example-provider.test";
const GATEWAY_ORIGIN = "https://gateway.example-cloud.test";
const LOCAL_CONN_ID = "conn_local_test_handle_000001";
const MANAGED_CONN_ID = "conn_managed_cloud_handle_01";

function localConnection(overrides?: {
	credential?: string;
	baseOrigin?: string;
}): ResolvedProviderConnection {
	return resolveProviderConnection({
		mode: "local",
		providerId: "maps",
		connectionId: LOCAL_CONN_ID,
		baseUrl: overrides?.baseOrigin ?? PUBLIC_ORIGIN,
		...(overrides?.credential !== undefined
			? { credential: overrides.credential }
			: {}),
	});
}

function managedConnection(): ResolvedProviderConnection {
	return resolveProviderConnection({
		mode: "managed",
		providerId: "maps",
		connectionId: MANAGED_CONN_ID,
		gatewayBaseUrl: GATEWAY_ORIGIN,
	});
}

interface SeenRequest {
	input: string;
	init?: RequestInit;
}

type FetchLike = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

function capturingFetch(responder: () => Response): {
	fetchImpl: FetchLike;
	seen: SeenRequest[];
} {
	const seen: SeenRequest[] = [];
	return {
		fetchImpl(input, init) {
			seen.push({ input: String(input), init });
			return Promise.resolve(responder());
		},
		seen,
	};
}

function jsonBody(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const payloadSchema: ProviderResponseSchema<{ value: string }> = {
	safeParse(value) {
		if (
			value &&
			typeof value === "object" &&
			"value" in value &&
			typeof (value as { value: unknown }).value === "string"
		) {
			return {
				success: true,
				data: { value: (value as { value: string }).value },
			};
		}
		return { success: false, error: new Error("expected { value: string }") };
	},
};

const anythingSchema: ProviderResponseSchema<unknown> = {
	safeParse(value) {
		return { success: true, data: value };
	},
};

function caughtFrom(build: () => unknown): unknown {
	try {
		build();
	} catch (error) {
		return error;
	}
	throw new Error("expected the constructor to throw");
}

function buildClient(
	connection: ResolvedProviderConnection,
	options?: Partial<{
		timeoutMs: number;
		responseByteLimit: number;
		connectionIdHeader: string;
		fetchImpl: FetchLike;
		allowPrivateNetworkForTests: boolean;
	}>,
): ManagedProviderHttpClient {
	return new ManagedProviderHttpClient({
		connection,
		...(options?.timeoutMs !== undefined
			? { timeoutMs: options.timeoutMs }
			: {}),
		...(options?.responseByteLimit !== undefined
			? { responseByteLimit: options.responseByteLimit }
			: {}),
		...(options?.connectionIdHeader !== undefined
			? { connectionIdHeader: options.connectionIdHeader }
			: {}),
		...(options?.fetchImpl
			? { testTransport: { fetchImpl: options.fetchImpl } }
			: {}),
		...(options?.allowPrivateNetworkForTests
			? { allowPrivateNetworkForTests: true }
			: {}),
	});
}

describe("ManagedProviderHttpClient constructor", () => {
	it("rejects a managed connection that smuggles a provider credential", () => {
		const forged = {
			...managedConnection(),
			credential: "smuggled-token",
		} as unknown as ResolvedProviderConnection;

		expect(caughtFrom(() => buildClient(forged))).toMatchObject({
			name: "ManagedProviderError",
			code: "INVALID_INPUT",
		});
	});

	it("requires an injected fetch transport before allowing private-network endpoints", () => {
		expect(
			caughtFrom(
				() =>
					new ManagedProviderHttpClient({
						connection: localConnection(),
						allowPrivateNetworkForTests: true,
					}),
			),
		).toMatchObject({ name: "ManagedProviderError", code: "INVALID_INPUT" });
	});

	it("rejects a plaintext http origin unless private-network tests are enabled", () => {
		expect(
			caughtFrom(() =>
				buildClient(localConnection({ baseOrigin: "http://127.0.0.1:4599" })),
			),
		).toMatchObject({
			name: "ManagedProviderError",
			code: "INVALID_INPUT",
			context: undefined,
		});
	});

	it("blocks loopback and internal-host origins on the public path", () => {
		for (const origin of ["https://127.0.0.1", "https://localhost"]) {
			expect(
				caughtFrom(() => buildClient(localConnection({ baseOrigin: origin }))),
			).toMatchObject({
				name: "ManagedProviderError",
				code: "ENDPOINT_BLOCKED",
			});
		}
	});

	it("rejects connection-id header names outside the RFC token grammar", () => {
		for (const name of ["x eliza id", "x-eliza@id", 'x-"quoted"']) {
			expect(
				caughtFrom(() =>
					buildClient(localConnection(), { connectionIdHeader: name }),
				),
			).toMatchObject({ name: "ManagedProviderError", code: "INVALID_INPUT" });
		}
	});

	it("refuses a connection-id header that overlaps authentication case-insensitively", () => {
		for (const name of ["Authorization", "AUTHORIZATION"]) {
			expect(
				caughtFrom(() =>
					buildClient(localConnection(), { connectionIdHeader: name }),
				),
			).toMatchObject({ name: "ManagedProviderError", code: "INVALID_INPUT" });
		}
	});

	it("exposes the documented timeout and byte ceilings as exported constants", () => {
		expect(MANAGED_PROVIDER_DEFAULT_TIMEOUT_MS).toBe(10_000);
		expect(MANAGED_PROVIDER_MIN_TIMEOUT_MS).toBe(100);
		expect(MANAGED_PROVIDER_MAX_TIMEOUT_MS).toBe(60_000);
		expect(MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES).toBe(1024 * 1024);
		expect(MANAGED_PROVIDER_MAX_RESPONSE_BYTES).toBe(5 * 1024 * 1024);
	});

	it("accepts timeouts exactly at both bounds and rejects everything outside them", () => {
		for (const timeoutMs of [99, 100.5, 60_001]) {
			expect(
				caughtFrom(() => buildClient(localConnection(), { timeoutMs })),
			).toMatchObject({ name: "ManagedProviderError", code: "INVALID_INPUT" });
		}
		for (const timeoutMs of [100, 60_000]) {
			expect(buildClient(localConnection(), { timeoutMs })).toBeInstanceOf(
				ManagedProviderHttpClient,
			);
		}
	});

	it("constructs successfully when neither timeout nor byte limit is supplied", () => {
		expect(
			new ManagedProviderHttpClient({ connection: localConnection() }),
		).toBeInstanceOf(ManagedProviderHttpClient);
	});

	it("enforces integer response-byte limits within [1, 5MiB]", () => {
		for (const responseByteLimit of [
			0,
			-1,
			100.5,
			MANAGED_PROVIDER_MAX_RESPONSE_BYTES + 1,
		]) {
			expect(
				caughtFrom(() => buildClient(localConnection(), { responseByteLimit })),
			).toMatchObject({ name: "ManagedProviderError", code: "INVALID_INPUT" });
		}
		for (const responseByteLimit of [
			1,
			MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES + 1,
			MANAGED_PROVIDER_MAX_RESPONSE_BYTES,
		]) {
			expect(
				buildClient(localConnection(), { responseByteLimit }),
			).toBeInstanceOf(ManagedProviderHttpClient);
		}
	});
});

describe("url()", () => {
	it("joins a relative path onto the pinned connection origin", () => {
		const client = buildClient(localConnection());
		expect(client.url("/v1/geocode?q=a").href).toBe(
			`${PUBLIC_ORIGIN}/v1/geocode?q=a`,
		);
	});

	it("preserves query strings and fragments while staying on-origin", () => {
		const client = buildClient(localConnection());
		expect(client.url("/v1/geocode?q=a&b=c#results").href).toBe(
			`${PUBLIC_ORIGIN}/v1/geocode?q=a&b=c#results`,
		);
	});

	it("normalizes dot-segments that resolve back onto the pinned origin", () => {
		const client = buildClient(localConnection());
		expect(client.url("/v1/maps/../geocode").href).toBe(
			`${PUBLIC_ORIGIN}/v1/geocode`,
		);
	});

	it("rejects an absolute URL that escapes the configured origin", () => {
		const client = buildClient(localConnection());
		expect(
			caughtFrom(() => client.url("https://evil.example.test/v1")),
		).toMatchObject({ name: "ManagedProviderError", code: "ENDPOINT_BLOCKED" });
	});

	it("rejects protocol-relative targets carrying userinfo", () => {
		const client = buildClient(localConnection());
		expect(
			caughtFrom(() => client.url("//u:p@api.example-provider.test/v1")),
		).toMatchObject({ name: "ManagedProviderError", code: "ENDPOINT_BLOCKED" });
	});
});

describe("requestJson happy path", () => {
	it("decodes the provider payload and forwards caller intent on the pinned transport", async () => {
		const { fetchImpl, seen } = capturingFetch(() => jsonBody({ value: "ok" }));
		const client = buildClient(
			localConnection({ credential: "secret-token" }),
			{ fetchImpl },
		);

		const data = await client.requestJson(
			client.url("/v1/geocode?q=a"),
			{ method: "GET" },
			payloadSchema,
		);

		expect(data).toEqual({ value: "ok" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.input).toBe(`${PUBLIC_ORIGIN}/v1/geocode?q=a`);
		const headers = new Headers(seen[0]?.init?.headers);
		expect(headers.get("x-eliza-connection-id")).toBe(LOCAL_CONN_ID);
		expect(headers.get("authorization")).toBe("Bearer secret-token");
	});

	it("replaces a caller-supplied Authorization header with the connection credential", async () => {
		const { fetchImpl, seen } = capturingFetch(() => jsonBody({ value: "ok" }));
		const client = buildClient(
			localConnection({ credential: "secret-token" }),
			{ fetchImpl },
		);

		await client.requestJson(
			client.url("/v1/geocode"),
			{ headers: { authorization: "caller-attempt" } },
			payloadSchema,
		);

		const headers = new Headers(seen[0]?.init?.headers);
		expect(headers.get("authorization")).toBe("Bearer secret-token");
	});

	it("strips Authorization entirely when the connection carries no credential", async () => {
		const { fetchImpl, seen } = capturingFetch(() => jsonBody({ value: "ok" }));
		const client = buildClient(localConnection(), { fetchImpl });

		await client.requestJson(
			client.url("/v1/geocode"),
			{ headers: { authorization: "caller-attempt" } },
			payloadSchema,
		);

		expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBeNull();
	});

	it("never emits Authorization on managed-mode requests while still tagging the connection id", async () => {
		const { fetchImpl, seen } = capturingFetch(() => jsonBody({ value: "ok" }));
		const client = buildClient(managedConnection(), { fetchImpl });

		await client.requestJson(
			client.url("/v1/geocode"),
			{ headers: { authorization: "caller-attempt" } },
			payloadSchema,
		);

		const headers = new Headers(seen[0]?.init?.headers);
		expect(headers.get("x-eliza-connection-id")).toBe(MANAGED_CONN_ID);
		expect(headers.get("authorization")).toBeNull();
	});

	it("honours a custom connection-id header name end to end", async () => {
		const { fetchImpl, seen } = capturingFetch(() => jsonBody({ value: "ok" }));
		const client = buildClient(localConnection(), {
			fetchImpl,
			connectionIdHeader: "x-acme-connection",
		});

		await client.requestJson(client.url("/v1/geocode"), {}, payloadSchema);

		expect(new Headers(seen[0]?.init?.headers).get("x-acme-connection")).toBe(
			LOCAL_CONN_ID,
		);
	});

	it("forwards POST bodies untouched", async () => {
		const { fetchImpl, seen } = capturingFetch(() => jsonBody({ value: "ok" }));
		const client = buildClient(
			localConnection({ credential: "secret-token" }),
			{ fetchImpl },
		);
		const body = JSON.stringify({ lat: 1, lon: 2 });

		await client.requestJson(
			client.url("/v1/route"),
			{
				method: "POST",
				body,
				headers: { "content-type": "application/json" },
			},
			payloadSchema,
		);

		expect(seen[0]?.init?.method).toBe("POST");
		expect(seen[0]?.init?.body).toBe(body);
		expect(new Headers(seen[0]?.init?.headers).get("content-type")).toBe(
			"application/json",
		);
	});
});

describe("404 handling", () => {
	it("maps an upstream 404 to designed null by default", async () => {
		const { fetchImpl } = capturingFetch(
			() => new Response("missing", { status: 404 }),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestOptionalJson(client.url("/v1/place"), {}, payloadSchema),
		).resolves.toBeNull();
	});

	it("classifies a 404 as PROVIDER_REJECTED when null is not allowed", async () => {
		const { fetchImpl } = capturingFetch(
			() => new Response("missing", { status: 404 }),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/place"), {}, payloadSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "PROVIDER_REJECTED",
			context: { status: 404 },
		});
	});

	it("honours an explicit notFoundIsNull:false on the optional surface", async () => {
		const { fetchImpl } = capturingFetch(
			() => new Response("missing", { status: 404 }),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestOptionalJson(client.url("/v1/place"), {}, payloadSchema, {
				notFoundIsNull: false,
			}),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "PROVIDER_REJECTED",
			context: { status: 404 },
		});
	});
});

describe("upstream error classification", () => {
	it("reports AUTH_EXPIRED for a plain 401", async () => {
		const { fetchImpl } = capturingFetch(() =>
			jsonBody({ message: "token expired" }, 401),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "AUTH_EXPIRED",
			context: { status: 401 },
		});
	});

	it("classifies a 403 without the revoked marker as PROVIDER_REJECTED", async () => {
		const { fetchImpl } = capturingFetch(() =>
			jsonBody({ error: "forbidden" }, 403),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "PROVIDER_REJECTED",
			context: { status: 403 },
		});
	});

	it("upgrades to AUTH_REVOKED when a 401 body declares credential_revoked", async () => {
		const { fetchImpl } = capturingFetch(() =>
			jsonBody({ code: "credential_revoked" }, 401),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "AUTH_REVOKED",
			context: { status: 401 },
		});
	});

	it("recognises credential_revoked on 403 responses too", async () => {
		const { fetchImpl } = capturingFetch(() =>
			jsonBody({ code: "credential_revoked" }, 403),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({ code: "AUTH_REVOKED" });
	});

	it("keeps AUTH_EXPIRED when a 401 body carries some other provider code", async () => {
		const { fetchImpl } = capturingFetch(() =>
			jsonBody({ code: "token_stale" }, 401),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
	});

	it("still reports AUTH_EXPIRED when the 401 diagnostic body cannot be decoded", async () => {
		const { fetchImpl } = capturingFetch(
			() =>
				new Response("<html>gateway hiccup</html>", {
					status: 401,
					headers: { "content-length": "999999999" },
				}),
		);
		const client = buildClient(localConnection(), {
			fetchImpl,
			responseByteLimit: 64,
		});

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "AUTH_EXPIRED",
		});
	});

	it("parses numeric retry-after seconds into RATE_LIMITED retryAfterMs", async () => {
		const { fetchImpl } = capturingFetch(
			() =>
				new Response('{"code":"quota"}', {
					status: 429,
					headers: { "retry-after": "7" },
				}),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		const error = await client
			.requestJson(client.url("/v1/geocode"), {}, payloadSchema)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ManagedProviderError);
		expect(error).toMatchObject({
			code: "RATE_LIMITED",
			retryAfterMs: 7000,
			context: { status: 429 },
		});
	});

	it("rounds fractional numeric retry-after seconds up to whole milliseconds", async () => {
		const { fetchImpl } = capturingFetch(
			() =>
				new Response("{}", { status: 429, headers: { "retry-after": "2.5" } }),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		const error = await client
			.requestJson(client.url("/v1/geocode"), {}, payloadSchema)
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2500 });
	});

	it("parses an HTTP-date retry-after against the current clock", async () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-24T00:00:00Z"));
		const { fetchImpl } = capturingFetch(
			() =>
				new Response("{}", {
					status: 429,
					headers: { "retry-after": "Wed, 26 Aug 2026 00:01:00 GMT" },
				}),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		const error = await client
			.requestJson(client.url("/v1/geocode"), {}, payloadSchema)
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "RATE_LIMITED",
			retryAfterMs: 172_860_000,
		});
	});

	it("clamps a stale HTTP-date retry-after to zero instead of a negative delay", async () => {
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-24T00:00:00Z"));
		const { fetchImpl } = capturingFetch(
			() =>
				new Response("{}", {
					status: 429,
					headers: { "retry-after": "Mon, 24 Aug 2026 00:00:00 GMT" },
				}),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		const error = await client
			.requestJson(client.url("/v1/geocode"), {}, payloadSchema)
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 0 });
	});

	it("leaves retryAfterMs unset for an unparseable retry-after value", async () => {
		const { fetchImpl } = capturingFetch(
			() =>
				new Response("{}", {
					status: 429,
					headers: { "retry-after": "soon-ish" },
				}),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		const error = await client
			.requestJson(client.url("/v1/geocode"), {}, payloadSchema)
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			code: "RATE_LIMITED",
			retryAfterMs: undefined,
		});
	});

	it("classifies 5xx as PROVIDER_FAILURE with the upstream status in context", async () => {
		const { fetchImpl } = capturingFetch(() => jsonBody({ boom: true }, 503));
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			code: "PROVIDER_FAILURE",
			context: { status: 503 },
		});
	});
});

describe("response body bounds and decoding", () => {
	it("rejects before reading when declared content-length exceeds the limit", async () => {
		const { fetchImpl } = capturingFetch(
			() =>
				new Response("{}", {
					status: 200,
					headers: { "content-length": "1048577" },
				}),
		);
		const client = buildClient(localConnection(), {
			fetchImpl,
			responseByteLimit: 16,
		});

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "RESPONSE_TOO_LARGE",
			context: { status: 200, limit: 16 },
		});
	});

	it("proves the default ceiling is the exported 1MiB constant", async () => {
		const { fetchImpl } = capturingFetch(
			() =>
				new Response("{}", {
					status: 200,
					headers: {
						"content-length": String(
							MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES + 1,
						),
					},
				}),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			code: "RESPONSE_TOO_LARGE",
			context: { limit: MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES },
		});
	});

	it("cancels mid-stream once accumulated bytes exceed the limit", async () => {
		const encoder = new TextEncoder();
		let cancelled = false;
		let emitted = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (emitted === 0) {
					emitted = 1;
					controller.enqueue(encoder.encode("123456"));
				} else if (emitted === 1) {
					emitted = 2;
					controller.enqueue(encoder.encode("789012"));
				}
			},
			cancel() {
				cancelled = true;
			},
		});
		const { fetchImpl } = capturingFetch(
			() => new Response(stream, { status: 200 }),
		);
		const client = buildClient(localConnection(), {
			fetchImpl,
			responseByteLimit: 10,
		});

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "RESPONSE_TOO_LARGE",
			context: { limit: 10 },
		});
		expect(cancelled).toBe(true);
	});

	it("accepts a body whose size lands exactly on the limit", async () => {
		const raw = JSON.stringify({ value: "boundary!" });
		const { fetchImpl } = capturingFetch(
			() =>
				new Response(raw, {
					status: 200,
					headers: { "content-length": String(raw.length) },
				}),
		);
		const client = buildClient(localConnection(), {
			fetchImpl,
			responseByteLimit: raw.length,
		});

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).resolves.toEqual({ value: "boundary!" });
	});

	it("reports MALFORMED_RESPONSE for non-UTF-8 bytes instead of lossy text", async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([0xff, 0xfe, 0xfa]));
				controller.close();
			},
		});
		const { fetchImpl } = capturingFetch(
			() => new Response(stream, { status: 200 }),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, anythingSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "MALFORMED_RESPONSE",
			context: { status: 200 },
		});
	});

	it("reports MALFORMED_RESPONSE for a truncated JSON document", async () => {
		const { fetchImpl } = capturingFetch(
			() => new Response('{"value":"cut', { status: 200 }),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
	});

	it("reports MALFORMED_RESPONSE for an empty success body", async () => {
		const { fetchImpl } = capturingFetch(
			() => new Response("", { status: 200 }),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, anythingSchema),
		).rejects.toMatchObject({ code: "MALFORMED_RESPONSE" });
	});

	it("surfaces schema drift as MALFORMED_RESPONSE while keeping the parse cause", async () => {
		const { fetchImpl } = capturingFetch(() => jsonBody({ unexpected: true }));
		const client = buildClient(localConnection(), { fetchImpl });

		const error = await client
			.requestJson(client.url("/v1/geocode"), {}, payloadSchema)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ManagedProviderError);
		expect(error).toMatchObject({
			code: "MALFORMED_RESPONSE",
			context: { status: 200 },
		});
		expect((error as ManagedProviderError).cause).toBeInstanceOf(Error);
	});

	it("returns a JSON-null payload as designed null through the optional surface", async () => {
		const { fetchImpl } = capturingFetch(() => jsonBody(null));
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestOptionalJson(client.url("/v1/geocode"), {}, anythingSchema),
		).resolves.toBeNull();
	});

	it("rejects a JSON-null payload through the required surface", async () => {
		const { fetchImpl } = capturingFetch(() => jsonBody(null));
		const client = buildClient(localConnection(), { fetchImpl });

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, anythingSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "MALFORMED_RESPONSE",
		});
	});
});

describe("transport failure mapping", () => {
	it("wraps generic socket failures as PROVIDER_NETWORK preserving the cause", async () => {
		const client = buildClient(localConnection(), {
			fetchImpl: () => Promise.reject(new TypeError("connect ECONNREFUSED")),
		});

		const error = await client
			.requestJson(client.url("/v1/geocode"), {}, payloadSchema)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ManagedProviderError);
		expect(error).toMatchObject({
			name: "ManagedProviderError",
			code: "PROVIDER_NETWORK",
		});
		expect((error as ManagedProviderError).cause).toBeInstanceOf(TypeError);
	});

	it("maps a transport-level SsrfBlockedError to ENDPOINT_BLOCKED preserving the cause", async () => {
		const blocked = new SsrfBlockedError(
			"Blocked hostname: api.example-provider.test",
		);
		const client = buildClient(localConnection(), {
			fetchImpl: () => Promise.reject(blocked),
		});

		const error = await client
			.requestJson(client.url("/v1/geocode"), {}, payloadSchema)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ManagedProviderError);
		expect(error).toMatchObject({
			name: "ManagedProviderError",
			code: "ENDPOINT_BLOCKED",
		});
		expect((error as ManagedProviderError).cause).toBe(blocked);
	});

	it("refuses to follow redirects past the zero-hop budget", async () => {
		const { fetchImpl } = capturingFetch(
			() =>
				new Response(null, {
					status: 302,
					headers: { location: "https://evil.example.test/capture" },
				}),
		);
		const client = buildClient(localConnection(), { fetchImpl });

		const error = await client
			.requestJson(client.url("/v1/geocode"), {}, payloadSchema)
			.catch((caught: unknown) => caught);

		expect(error).toMatchObject({
			name: "ManagedProviderError",
			code: "PROVIDER_NETWORK",
		});
		expect((error as ManagedProviderError).cause).toBeInstanceOf(Error);
		expect(String((error as ManagedProviderError).cause)).toContain("redirect");
	});

	it("classifies an AbortError-named transport failure as PROVIDER_TIMEOUT without waiting", async () => {
		const client = buildClient(localConnection(), {
			fetchImpl: () =>
				Promise.reject(new DOMException("aborted by transport", "AbortError")),
		});

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "PROVIDER_TIMEOUT",
		});
	});

	it("classifies an elapsed deadline as PROVIDER_TIMEOUT", async () => {
		const client = buildClient(localConnection(), {
			timeoutMs: 100,
			fetchImpl: (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					const signal = init?.signal;
					if (!signal) {
						reject(new TypeError("transport requires an abort signal"));
						return;
					}
					if (signal.aborted) {
						reject(signal.reason);
						return;
					}
					signal.addEventListener("abort", () => reject(signal.reason), {
						once: true,
					});
				}),
		});

		await expect(
			client.requestJson(client.url("/v1/geocode"), {}, payloadSchema),
		).rejects.toMatchObject({
			name: "ManagedProviderError",
			code: "PROVIDER_TIMEOUT",
		});
	});

	it("reaches loopback fakes when private networking is explicitly allowed for tests", async () => {
		const { fetchImpl, seen } = capturingFetch(() =>
			jsonBody({ value: "loopback" }),
		);
		const client = buildClient(
			localConnection({
				baseOrigin: "http://127.0.0.1:4599",
				credential: "secret-token",
			}),
			{ fetchImpl, allowPrivateNetworkForTests: true },
		);

		const data = await client.requestJson(
			client.url("/v1/local"),
			{},
			payloadSchema,
		);

		expect(data).toEqual({ value: "loopback" });
		expect(seen[0]?.input).toBe("http://127.0.0.1:4599/v1/local");
		expect(new Headers(seen[0]?.init?.headers).get("authorization")).toBe(
			"Bearer secret-token",
		);
	});
});
