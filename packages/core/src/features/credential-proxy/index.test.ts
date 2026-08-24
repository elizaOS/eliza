/**
 * Tests the credential-proxy public barrel — the surface `index.node.ts`
 * re-exports to consumers: composing `resolveCredentialProxyConfig` output
 * into a signing `createCredentialProxyFetch`, the signable-body rules
 * (string / Uint8Array / ArrayBuffer accepted, streaming rejected), and
 * fail-closed allowlist edges (ordering, case normalization, prefix/query
 * matching). Driven entirely through `./index.ts`. Deterministic: real
 * node:crypto, a recording stub fetch, a fixed clock.
 */
import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertRouteAllowed,
	CREDENTIAL_PROXY_HEADER_SIGNATURE,
	CREDENTIAL_PROXY_HEADER_TARGET,
	CREDENTIAL_PROXY_HEADER_TIMESTAMP,
	type CredentialProxyRoute,
	CredentialProxyRouteError,
	createCredentialProxyFetch,
	resolveCredentialProxyConfig,
} from "./index.ts";

function fromMap(map: Record<string, string | undefined>) {
	return (key: string) => map[key];
}

const ROUTES: CredentialProxyRoute[] = [
	{ host: "github.com", methods: ["GET", "POST"], pathPrefix: "/" },
	{ host: "api.github.com", methods: ["GET"], pathPrefix: "/repos/" },
];

function stubFetch() {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response("ok", { status: 200 });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

/** Independently reproduce the signed wire contract (prefix included). */
function expectedSignature(
	key: string,
	parts: {
		method: string;
		host: string;
		pathAndSearch: string;
		timestamp: string;
		body: Uint8Array;
	},
) {
	const canonical = [
		"eliza-credential-proxy-v1",
		parts.method.toUpperCase(),
		parts.host.toLowerCase(),
		parts.pathAndSearch,
		parts.timestamp,
		createHash("sha256").update(parts.body).digest("hex"),
	].join("\n");
	return `v1=${createHmac("sha256", key).update(canonical).digest("hex")}`;
}

describe("credential-proxy barrel — env config composed into a signing client", () => {
	it("turns resolved env config into a proxied request that verifies against the wire contract", async () => {
		const cfg = resolveCredentialProxyConfig(
			fromMap({
				ELIZA_CREDENTIAL_PROXY_URL: "https://proxy.internal/broker",
				ELIZA_CREDENTIAL_PROXY_TOKEN: "agent-handle",
				ELIZA_CREDENTIAL_PROXY_SIGNING_KEY: "shared-hmac-key",
			}),
		);
		expect(cfg?.strict).toBe(false);
		if (!cfg) throw new Error("expected config to resolve");

		const { calls, fetchImpl } = stubFetch();
		const fetchProxy = createCredentialProxyFetch({
			url: cfg.url,
			token: cfg.token,
			signingKey: cfg.signingKey,
			routes: ROUTES,
			fetchImpl,
			now: () => 1_700_000_123_456,
		});

		const res = await fetchProxy(
			"https://api.github.com/repos/o/r/issues?q=1",
			{ method: "get" },
		);
		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);

		const forwarded = new URL(calls[0].url);
		expect(forwarded.origin).toBe("https://proxy.internal");
		expect(forwarded.pathname).toBe("/repos/o/r/issues");
		expect(forwarded.search).toBe("?q=1");

		const headers = new Headers(calls[0].init.headers);
		expect(headers.get("authorization")).toBe("Bearer agent-handle");
		expect(headers.get(CREDENTIAL_PROXY_HEADER_TARGET)).toBe(
			"https://api.github.com",
		);
		expect(headers.get(CREDENTIAL_PROXY_HEADER_TIMESTAMP)).toBe("1700000123");
		expect(headers.get(CREDENTIAL_PROXY_HEADER_SIGNATURE)).toBe(
			expectedSignature("shared-hmac-key", {
				method: "GET",
				host: "api.github.com",
				pathAndSearch: "/repos/o/r/issues?q=1",
				timestamp: "1700000123",
				body: new Uint8Array(0),
			}),
		);
	});

	it("defaults the forwarded method to GET when init is omitted", async () => {
		const { calls, fetchImpl } = stubFetch();
		const fetchProxy = createCredentialProxyFetch({
			url: "https://proxy.internal/broker",
			token: "t",
			routes: ROUTES,
			fetchImpl,
		});
		await fetchProxy("https://github.com/o/r");
		expect(calls[0].init.method).toBe("GET");
	});
});

describe("credential-proxy barrel — signable body handling", () => {
	it("signs and forwards a Uint8Array body byte-for-byte", async () => {
		const { calls, fetchImpl } = stubFetch();
		const fetchProxy = createCredentialProxyFetch({
			url: "https://proxy.internal/broker",
			token: "t",
			signingKey: "k",
			routes: ROUTES,
			fetchImpl,
			now: () => 1_700_000_000_000,
		});
		const body = new TextEncoder().encode('{"ref":"refs/heads/f"}');
		await fetchProxy("https://github.com/o/r.git", { method: "POST", body });

		expect(calls[0].init.body).toBe(body);
		const headers = new Headers(calls[0].init.headers);
		expect(headers.get(CREDENTIAL_PROXY_HEADER_SIGNATURE)).toBe(
			expectedSignature("k", {
				method: "POST",
				host: "github.com",
				pathAndSearch: "/o/r.git",
				timestamp: "1700000000",
				body,
			}),
		);
	});

	it("signs an ArrayBuffer body over its bytes", async () => {
		const { calls, fetchImpl } = stubFetch();
		const fetchProxy = createCredentialProxyFetch({
			url: "https://proxy.internal/broker",
			token: "t",
			signingKey: "k",
			routes: ROUTES,
			fetchImpl,
			now: () => 1_700_000_000_000,
		});
		const raw = new TextEncoder().encode("payload");
		const buffer = raw.buffer.slice(
			raw.byteOffset,
			raw.byteOffset + raw.byteLength,
		);
		await fetchProxy("https://github.com/upload", {
			method: "POST",
			body: buffer,
		});

		const headers = new Headers(calls[0].init.headers);
		expect(headers.get(CREDENTIAL_PROXY_HEADER_SIGNATURE)).toBe(
			expectedSignature("k", {
				method: "POST",
				host: "github.com",
				pathAndSearch: "/upload",
				timestamp: "1700000000",
				body: new Uint8Array(buffer),
			}),
		);
	});

	it("rejects a streaming body before any network call", async () => {
		const { calls, fetchImpl } = stubFetch();
		const fetchProxy = createCredentialProxyFetch({
			url: "https://proxy.internal/broker",
			token: "t",
			signingKey: "k",
			routes: ROUTES,
			fetchImpl,
		});
		await expect(
			fetchProxy("https://github.com/o/r", {
				method: "POST",
				body: new ReadableStream(),
			}),
		).rejects.toThrow(/streaming bodies are not signable/);
		expect(calls).toHaveLength(0);
	});
});

describe("credential-proxy barrel — allowlist edges (fail-closed)", () => {
	it("an empty allowlist rejects every target", () => {
		expect(() =>
			assertRouteAllowed([], "GET", new URL("https://github.com/")),
		).toThrow(CredentialProxyRouteError);
	});

	it("returns the first matching route in declaration order, not the most specific", () => {
		const narrow: CredentialProxyRoute = {
			host: "github.com",
			methods: ["GET"],
			pathPrefix: "/a/",
		};
		const wide: CredentialProxyRoute = {
			host: "github.com",
			methods: ["GET"],
			pathPrefix: "/",
		};
		expect(
			assertRouteAllowed(
				[narrow, wide],
				"GET",
				new URL("https://github.com/a/x"),
			),
		).toBe(narrow);
		expect(
			assertRouteAllowed(
				[narrow, wide],
				"GET",
				new URL("https://github.com/b/x"),
			),
		).toBe(wide);
	});

	it("matches methods case-insensitively but route hosts exactly", () => {
		const route: CredentialProxyRoute = {
			host: "api.github.com",
			methods: ["GET"],
			pathPrefix: "/repos/",
		};
		expect(
			assertRouteAllowed(
				[route],
				"get",
				new URL("https://api.github.com/repos/o/r"),
			),
		).toBe(route);
		// A mixed-case declared host can never equal the lower-cased target
		// hostname, so the request fails closed.
		const mixedCaseHost: CredentialProxyRoute = {
			host: "GitHub.com",
			methods: ["GET"],
			pathPrefix: "/",
		};
		expect(() =>
			assertRouteAllowed(
				[mixedCaseHost],
				"GET",
				new URL("https://github.com/o/r"),
			),
		).toThrow(CredentialProxyRouteError);
	});

	it("treats an empty pathPrefix as matching every path on the host", () => {
		const route: CredentialProxyRoute = {
			host: "github.com",
			methods: ["GET"],
			pathPrefix: "",
		};
		expect(
			assertRouteAllowed([route], "GET", new URL("https://github.com/")),
		).toBe(route);
		expect(
			assertRouteAllowed([route], "GET", new URL("https://github.com/a/b/c")),
		).toBe(route);
	});

	it("matches on pathname only, so query strings neither help nor hurt the prefix", () => {
		const route: CredentialProxyRoute = {
			host: "api.github.com",
			methods: ["GET"],
			pathPrefix: "/repos/",
		};
		expect(
			assertRouteAllowed(
				[route],
				"GET",
				new URL("https://api.github.com/repos/o/r?token=x"),
			),
		).toBe(route);
		// "/repository" shares a textual prefix with "/repos/" but is a
		// different path segment — still denied.
		expect(() =>
			assertRouteAllowed(
				[route],
				"GET",
				new URL("https://api.github.com/repository"),
			),
		).toThrow(CredentialProxyRouteError);
	});

	it("the denial error names the method and full target URL", () => {
		try {
			assertRouteAllowed(ROUTES, "DELETE", new URL("https://github.com/o/r"));
			throw new Error("expected assertRouteAllowed to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(CredentialProxyRouteError);
			const err = error as CredentialProxyRouteError;
			expect(err.name).toBe("CredentialProxyRouteError");
			expect(err.message).toContain(
				"Credential-proxy route not allowed: DELETE https://github.com/o/r.",
			);
		}
	});
});
