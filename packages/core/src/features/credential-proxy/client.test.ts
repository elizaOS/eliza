import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertRouteAllowed,
	buildCredentialProxyCanonicalString,
	CREDENTIAL_PROXY_HEADER_SIGNATURE,
	CREDENTIAL_PROXY_HEADER_TARGET,
	CREDENTIAL_PROXY_HEADER_TIMESTAMP,
	type CredentialProxyRoute,
	CredentialProxyRouteError,
	createCredentialProxyFetch,
	credentialProxyBodyHash,
	signCredentialProxyRequest,
} from "./client.ts";

const ROUTES: CredentialProxyRoute[] = [
	{ host: "github.com", methods: ["GET", "POST"], pathPrefix: "/" },
	{ host: "api.github.com", methods: ["GET", "POST"], pathPrefix: "/repos/" },
];

function stubFetch() {
	const calls: { url: string; init: RequestInit }[] = [];
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		calls.push({ url: String(url), init: init ?? {} });
		return new Response("ok", { status: 200 });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}

describe("credential-proxy client — signing + forwarding", () => {
	it("forwards to the proxy with bearer, target header, preserved path, and a valid HMAC signature", async () => {
		const { calls, fetchImpl } = stubFetch();
		const fetchProxy = createCredentialProxyFetch({
			url: "https://proxy.internal:8443/broker",
			token: "agent-handle-abc",
			signingKey: "shared-hmac-key",
			routes: ROUTES,
			fetchImpl,
			now: () => 1_700_000_000_000,
		});

		const res = await fetchProxy(
			"https://api.github.com/repos/o/r/git/refs?x=1",
			{ method: "POST", body: '{"ref":"refs/heads/f"}' },
		);
		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);

		// Forwarded to the proxy origin, target path preserved under the base path.
		const forwarded = new URL(calls[0].url);
		expect(forwarded.host).toBe("proxy.internal:8443");
		expect(forwarded.pathname).toBe("/repos/o/r/git/refs");
		expect(forwarded.search).toBe("?x=1");

		const headers = new Headers(calls[0].init.headers);
		expect(headers.get("authorization")).toBe("Bearer agent-handle-abc");
		// The raw credential is never carried — only the scoped handle.
		expect(headers.get("authorization")).not.toContain("ghp_");
		expect(headers.get(CREDENTIAL_PROXY_HEADER_TARGET)).toBe(
			"https://api.github.com",
		);
		expect(headers.get(CREDENTIAL_PROXY_HEADER_TIMESTAMP)).toBe("1700000000");

		// Reproduce the signature independently and assert it verifies.
		const bodyHash = createHash("sha256")
			.update('{"ref":"refs/heads/f"}')
			.digest("hex");
		const canonical = buildCredentialProxyCanonicalString({
			method: "POST",
			targetHost: "api.github.com",
			pathAndSearch: "/repos/o/r/git/refs?x=1",
			timestamp: "1700000000",
			bodyHash,
		});
		const expected = `v1=${createHmac("sha256", "shared-hmac-key").update(canonical).digest("hex")}`;
		expect(headers.get(CREDENTIAL_PROXY_HEADER_SIGNATURE)).toBe(expected);
	});

	it("omits the signature header when no signing key is configured", async () => {
		const { calls, fetchImpl } = stubFetch();
		const fetchProxy = createCredentialProxyFetch({
			url: "https://proxy.internal/broker",
			token: "t",
			routes: ROUTES,
			fetchImpl,
		});
		await fetchProxy(
			"https://github.com/o/r.git/info/refs?service=git-receive-pack",
		);
		const headers = new Headers(calls[0].init.headers);
		expect(headers.get(CREDENTIAL_PROXY_HEADER_SIGNATURE)).toBeNull();
		expect(headers.get("authorization")).toBe("Bearer t");
	});

	it("hashes the body deterministically", () => {
		expect(credentialProxyBodyHash(new TextEncoder().encode("abc"))).toBe(
			createHash("sha256").update("abc").digest("hex"),
		);
		expect(credentialProxyBodyHash(new Uint8Array(0))).toBe(
			createHash("sha256").update(new Uint8Array(0)).digest("hex"),
		);
	});
});

describe("credential-proxy client — per-host allowlist (fail-closed)", () => {
	it("rejects an off-allowlist host before any network call", async () => {
		const { calls, fetchImpl } = stubFetch();
		const fetchProxy = createCredentialProxyFetch({
			url: "https://proxy.internal/broker",
			token: "t",
			routes: ROUTES,
			fetchImpl,
		});
		await expect(
			fetchProxy("https://evil.example.com/repos/o/r", { method: "GET" }),
		).rejects.toBeInstanceOf(CredentialProxyRouteError);
		expect(calls).toHaveLength(0);
	});

	it("rejects a method not on the route", () => {
		expect(() =>
			assertRouteAllowed(ROUTES, "DELETE", new URL("https://github.com/o/r")),
		).toThrow(CredentialProxyRouteError);
	});

	it("rejects a path outside the route prefix", () => {
		// api.github.com only brokers /repos/*, not /user
		expect(() =>
			assertRouteAllowed(ROUTES, "GET", new URL("https://api.github.com/user")),
		).toThrow(CredentialProxyRouteError);
	});

	it("accepts an in-prefix, in-method target", () => {
		const route = assertRouteAllowed(
			ROUTES,
			"post",
			new URL("https://api.github.com/repos/o/r/issues"),
		);
		expect(route.host).toBe("api.github.com");
	});

	it("signCredentialProxyRequest is a versioned HMAC hex", () => {
		const sig = signCredentialProxyRequest("k", "canonical");
		expect(sig).toBe(
			`v1=${createHmac("sha256", "k").update("canonical").digest("hex")}`,
		);
	});
});
