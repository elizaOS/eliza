/**
 * Exercises the managed-provider SDK facade that integration plugins import
 * (`./index`): every runtime re-export is driven through the single public
 * entry and composed over one resolved connection — connection resolution,
 * guarded client construction, auth-tagged JSON requests, health probing, and
 * cursor pagination whose typed failures narrow through the facade's own
 * taxonomy helpers onto capability execution outcomes. Fully deterministic;
 * every request runs against an in-memory injected fetch with no network.
 */

import { describe, expect, it } from "vitest";
import { ElizaError } from "../../errors";
import {
	collectProviderPages,
	isManagedProviderError,
	isOpaqueConnectionId,
	type LocalConnectionConfig,
	MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES,
	MANAGED_PROVIDER_DEFAULT_TIMEOUT_MS,
	MANAGED_PROVIDER_MAX_RESPONSE_BYTES,
	MANAGED_PROVIDER_MAX_TIMEOUT_MS,
	MANAGED_PROVIDER_MIN_TIMEOUT_MS,
	type ManagedConnectionConfig,
	ManagedProviderError,
	ManagedProviderHttpClient,
	type ProviderResponseSchema,
	probeProviderHealth,
	type ResolvedProviderConnection,
	resolveProviderConnection,
	toCapabilityExecutionErrorCode,
} from "./index";

const PUBLIC_ORIGIN = "https://api.example-facade.test";
const GATEWAY_ORIGIN = "https://gateway.example-facade.test";
const LOCAL_CONN_ID = "conn_facade_local_handle_00001";
const MANAGED_CONN_ID = "conn_facade_cloud_handle0001";

function localConfig(
	overrides?: Partial<Pick<LocalConnectionConfig, "credential" | "baseUrl">>,
): LocalConnectionConfig {
	return {
		mode: "local",
		providerId: "facade",
		connectionId: LOCAL_CONN_ID,
		baseUrl: PUBLIC_ORIGIN,
		credential: "facade-secret",
		...(overrides?.credential !== undefined
			? { credential: overrides.credential }
			: {}),
		...(overrides?.baseUrl !== undefined ? { baseUrl: overrides.baseUrl } : {}),
	};
}

function managedConfig(): ManagedConnectionConfig {
	return {
		mode: "managed",
		providerId: "facade",
		connectionId: MANAGED_CONN_ID,
		gatewayBaseUrl: GATEWAY_ORIGIN,
	};
}

interface SeenRequest {
	input: string;
	init?: RequestInit;
}

function capturingFetch(responder: () => Response): {
	fetchImpl: typeof fetch;
	seen: SeenRequest[];
} {
	const seen: SeenRequest[] = [];
	const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		seen.push({ input: String(input), init });
		return responder();
	}) as typeof fetch;
	return { fetchImpl, seen };
}

function jsonBody(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function caughtFrom(build: () => unknown): unknown {
	try {
		build();
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to throw");
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

const listingSchema: ProviderResponseSchema<{
	items: string[];
	nextCursor: string | null;
}> = {
	safeParse(value) {
		if (
			value &&
			typeof value === "object" &&
			Array.isArray((value as { items?: unknown }).items)
		) {
			const { items, nextCursor } = value as {
				items: string[];
				nextCursor: string | null;
			};
			if (typeof nextCursor === "string" || nextCursor === null) {
				return { success: true, data: { items, nextCursor } };
			}
		}
		return {
			success: false,
			error: new Error("expected { items, nextCursor }"),
		};
	},
};

describe("connection resolution through the facade", () => {
	it("resolves managed mode to the gateway origin without any credential", () => {
		const resolved = resolveProviderConnection(managedConfig());
		expect(resolved.mode).toBe("managed");
		expect(resolved.providerId).toBe("facade");
		expect(resolved.connectionId).toBe(MANAGED_CONN_ID);
		expect(resolved.baseOrigin).toBe(GATEWAY_ORIGIN);
		expect("credential" in resolved).toBe(false);
	});

	it("keeps the local credential on the resolved connection", () => {
		const resolved = resolveProviderConnection(localConfig());
		expect(resolved.mode).toBe("local");
		expect(resolved.baseOrigin).toBe(PUBLIC_ORIGIN);
		expect(resolved.credential).toBe("facade-secret");
	});

	it("rejects malformed provider ids and non-opaque connection ids as INVALID_INPUT", () => {
		expect(
			caughtFrom(() =>
				resolveProviderConnection({
					mode: "managed",
					providerId: "-not-a-provider",
					connectionId: MANAGED_CONN_ID,
					gatewayBaseUrl: GATEWAY_ORIGIN,
				}),
			),
		).toMatchObject({ name: "ManagedProviderError", code: "INVALID_INPUT" });
		expect(
			caughtFrom(() =>
				resolveProviderConnection({
					mode: "local",
					providerId: "facade",
					connectionId: "not-opaque-handle",
					baseUrl: PUBLIC_ORIGIN,
				}),
			),
		).toMatchObject({ name: "ManagedProviderError", code: "INVALID_INPUT" });
		expect(
			caughtFrom(() =>
				resolveProviderConnection({
					mode: "managed",
					providerId: "facade",
					connectionId: "tok_short",
					gatewayBaseUrl: GATEWAY_ORIGIN,
				}),
			),
		).toMatchObject({ name: "ManagedProviderError", code: "INVALID_INPUT" });
	});

	it("applies the opaque-id grammar to caller-supplied handles", () => {
		expect(isOpaqueConnectionId(`conn_${"a".repeat(16)}`)).toBe(true);
		expect(isOpaqueConnectionId(`conn_${"a".repeat(15)}`)).toBe(false);
		expect(isOpaqueConnectionId("conn_short")).toBe(false);
		expect(isOpaqueConnectionId(`x${"a".repeat(21)}`)).toBe(false);
		expect(isOpaqueConnectionId(`conn_${"a".repeat(15)}+`)).toBe(false);
	});
});

describe("client guardrails through the facade", () => {
	it("refuses a managed connection forged to carry a provider credential", () => {
		const forged = {
			...resolveProviderConnection(managedConfig()),
			credential: "smuggled-token",
		} as unknown as ResolvedProviderConnection;
		expect(
			caughtFrom(() => new ManagedProviderHttpClient({ connection: forged })),
		).toMatchObject({ name: "ManagedProviderError", code: "INVALID_INPUT" });
	});

	it("exposes ordered timeout and response-byte bounds", () => {
		expect(MANAGED_PROVIDER_MIN_TIMEOUT_MS).toBeLessThan(
			MANAGED_PROVIDER_DEFAULT_TIMEOUT_MS,
		);
		expect(MANAGED_PROVIDER_DEFAULT_TIMEOUT_MS).toBeLessThan(
			MANAGED_PROVIDER_MAX_TIMEOUT_MS,
		);
		expect(MANAGED_PROVIDER_DEFAULT_RESPONSE_BYTES).toBeLessThan(
			MANAGED_PROVIDER_MAX_RESPONSE_BYTES,
		);
	});
});

describe("one local connection drives requests through the facade", () => {
	it("sends the bearer credential and connection id, then decodes the payload", async () => {
		const { fetchImpl, seen } = capturingFetch(() =>
			jsonBody({ value: "facade-ok" }),
		);
		const client = new ManagedProviderHttpClient({
			connection: resolveProviderConnection(localConfig()),
			testTransport: { fetchImpl },
		});

		const data = await client.requestJson(
			client.url("/v1/things?id=7"),
			{ method: "GET" },
			payloadSchema,
		);

		expect(data).toEqual({ value: "facade-ok" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.input).toBe(`${PUBLIC_ORIGIN}/v1/things?id=7`);
		const headers = new Headers(seen[0]?.init?.headers);
		expect(headers.get("authorization")).toBe("Bearer facade-secret");
		expect(headers.get("x-eliza-connection-id")).toBe(LOCAL_CONN_ID);
	});

	it("narrows a live rate-limit failure and maps it onto the capability contract", async () => {
		const { fetchImpl } = capturingFetch(
			() =>
				new Response('{"code":"quota"}', {
					status: 429,
					headers: { "retry-after": "3" },
				}),
		);
		const client = new ManagedProviderHttpClient({
			connection: resolveProviderConnection(localConfig()),
			testTransport: { fetchImpl },
		});

		const error = await client
			.requestJson(client.url("/v1/things"), {}, payloadSchema)
			.then(
				() => null,
				(caught: unknown) => caught,
			);

		if (!isManagedProviderError(error)) {
			throw new Error("expected a ManagedProviderError");
		}
		expect(error.code).toBe("RATE_LIMITED");
		expect(error.severity).toBe("ephemeral");
		expect(error.retryAfterMs).toBe(3000);
		expect(toCapabilityExecutionErrorCode(error.code)).toBe("rate_limited");
	});

	it("classifies an origin escape as ENDPOINT_BLOCKED mapped to unknown_error", async () => {
		const client = new ManagedProviderHttpClient({
			connection: resolveProviderConnection(localConfig()),
		});

		const error = caughtFrom(() =>
			client.url("https://evil.example-facade.test/v1"),
		);
		if (!isManagedProviderError(error)) {
			throw new Error("expected a ManagedProviderError");
		}
		expect(error.code).toBe("ENDPOINT_BLOCKED");
		expect(toCapabilityExecutionErrorCode(error.code)).toBe("unknown_error");
	});
});

describe("health probing rides the same facade connection", () => {
	it("reports healthy against the managed gateway default path", async () => {
		const { fetchImpl, seen } = capturingFetch(() => jsonBody({ ok: true }));
		const client = new ManagedProviderHttpClient({
			connection: resolveProviderConnection(managedConfig()),
			testTransport: { fetchImpl },
		});

		const snapshot = await probeProviderHealth(client);

		expect(snapshot.state).toBe("healthy");
		expect(snapshot.code).toBeNull();
		expect(Number.isNaN(Date.parse(snapshot.checkedAt))).toBe(false);
		expect(seen.map((request) => new URL(request.input).pathname)).toEqual([
			"/health",
		]);
		expect(seen.map((request) => new URL(request.input).origin)).toEqual([
			GATEWAY_ORIGIN,
		]);
	});

	it("degrades a provider 5xx into a fatal degraded snapshot", async () => {
		const { fetchImpl } = capturingFetch(() => jsonBody({ boom: true }, 503));
		const client = new ManagedProviderHttpClient({
			connection: resolveProviderConnection(managedConfig()),
			testTransport: { fetchImpl },
		});

		const snapshot = await probeProviderHealth(client);

		expect(snapshot.state).toBe("degraded");
		expect(snapshot.code).toBe("PROVIDER_FAILURE");
		expect(toCapabilityExecutionErrorCode("PROVIDER_FAILURE")).toBe(
			"provider_error",
		);
	});
});

describe("pagination composes with the guarded client through the facade", () => {
	function listingClient(responders: Array<Record<string, unknown>>): {
		client: ManagedProviderHttpClient;
		seen: SeenRequest[];
	} {
		let calls = 0;
		const { fetchImpl, seen } = capturingFetch(() => {
			const body = responders[Math.min(calls, responders.length - 1)];
			calls += 1;
			return jsonBody(body);
		});
		const client = new ManagedProviderHttpClient({
			connection: resolveProviderConnection(localConfig()),
			testTransport: { fetchImpl },
		});
		return { client, seen };
	}

	const fetchPageFor =
		(client: ManagedProviderHttpClient) =>
		async (cursor: string | undefined) => {
			const path = cursor
				? `/v1/items?cursor=${encodeURIComponent(cursor)}`
				: "/v1/items";
			return client.requestJson(
				client.url(path),
				{ method: "GET" },
				listingSchema,
			);
		};

	it("drains a cursor chain into one ordered listing", async () => {
		const { client, seen } = listingClient([
			{ items: ["a"], nextCursor: "n1" },
			{ items: ["b"], nextCursor: null },
		]);

		await expect(collectProviderPages(fetchPageFor(client))).resolves.toEqual([
			"a",
			"b",
		]);
		expect(seen.map((request) => new URL(request.input).search)).toEqual([
			"",
			"?cursor=n1",
		]);
	});

	it("surfaces cursor loops as MALFORMED_RESPONSE mapped to schema_drift", async () => {
		const { client } = listingClient([
			{ items: ["x"], nextCursor: "same-cursor" },
		]);

		const error = await collectProviderPages(fetchPageFor(client)).then(
			() => null,
			(caught: unknown) => caught,
		);

		if (!isManagedProviderError(error)) {
			throw new Error("expected a ManagedProviderError");
		}
		expect(error.code).toBe("MALFORMED_RESPONSE");
		expect(error.severity).toBe("fatal");
		expect(toCapabilityExecutionErrorCode(error.code)).toBe("schema_drift");
	});
});

describe("error narrowing through the facade", () => {
	it("accepts taxonomy instances and rejects base ElizaErrors and non-errors", () => {
		const taxonomy = new ManagedProviderError("timeout during probe", {
			code: "PROVIDER_TIMEOUT",
		});
		expect(isManagedProviderError(taxonomy)).toBe(true);
		expect(
			isManagedProviderError(
				new ElizaError("base failure", { code: "UNCLASSIFIED" }),
			),
		).toBe(false);
		expect(isManagedProviderError(new Error("plain"))).toBe(false);
		expect(isManagedProviderError(null)).toBe(false);
		expect(isManagedProviderError("PROVIDER_TIMEOUT")).toBe(false);
	});
});
