/**
 * Behavioral suite for the SSRF fetch guard (fetchWithSsrfGuard): literal-host
 * blocking, DNS-pinned transport hand-off, and manual-redirect credential
 * stripping + method/body rewriting. Deterministic — stub fetch/lookup, no network.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchWithSsrfGuard } from "./fetch-guard.ts";
import { SsrfBlockedError } from "./ssrf.ts";

/**
 * Covers the environment-agnostic fallback path: when no `lookupFn` is supplied
 * (core has no node:dns to pin with), the guard must still block literal
 * internal targets and redirect-to-internal, while letting public hosts through.
 */
describe("fetchWithSsrfGuard without a lookupFn (literal-host checks)", () => {
	it("allows a public hostname (no DNS pin required)", async () => {
		const fetchImpl = vi.fn(async () => new Response("hi", { status: 200 }));
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://example.com/page",
			fetchImpl,
		});
		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await release();
	});

	it.each([
		"http://127.0.0.1/",
		"http://169.254.169.254/latest/meta-data",
		"http://10.0.0.1/",
		"http://192.168.1.1/",
		"http://[::1]/",
	])("blocks the literal internal target %s", async (url) => {
		const fetchImpl = vi.fn(
			async () => new Response("secret", { status: 200 }),
		);
		await expect(fetchWithSsrfGuard({ url, fetchImpl })).rejects.toBeInstanceOf(
			SsrfBlockedError,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([
		"http://localhost/admin",
		"http://metadata.google.internal/",
		"http://vault.internal/",
		"http://printer.local/",
	])("blocks the blocked hostname %s", async (url) => {
		const fetchImpl = vi.fn(
			async () => new Response("secret", { status: 200 }),
		);
		await expect(fetchWithSsrfGuard({ url, fetchImpl })).rejects.toBeInstanceOf(
			SsrfBlockedError,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("blocks a redirect from a public host to an internal target", async () => {
		const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).startsWith("https://example.com")) {
				return new Response(null, {
					status: 302,
					headers: { location: "http://169.254.169.254/latest/meta-data" },
				});
			}
			return new Response("secret", { status: 200 });
		});
		await expect(
			fetchWithSsrfGuard({ url: "https://example.com/redir", fetchImpl }),
		).rejects.toBeInstanceOf(SsrfBlockedError);
		// The internal hop is rejected before any fetch; only the public hop ran.
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("honors allowPrivateNetwork to permit a private target", async () => {
		const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
		const { response, release } = await fetchWithSsrfGuard({
			url: "http://127.0.0.1/",
			fetchImpl,
			policy: { allowPrivateNetwork: true },
		});
		expect(response.status).toBe(200);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		await release();
	});

	it("honors an explicit allowedHostnames entry", async () => {
		const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 }));
		const { response, release } = await fetchWithSsrfGuard({
			url: "http://localhost/",
			fetchImpl,
			policy: { allowedHostnames: ["localhost"] },
		});
		expect(response.status).toBe(200);
		await release();
	});
});

describe("fetchWithSsrfGuard with DNS pinning", () => {
	it("passes the vetted pinned lookup to the transport", async () => {
		let lookupCalls = 0;
		const lookupFn = async () => {
			lookupCalls += 1;
			return [{ address: "93.184.216.34", family: 4 }];
		};
		const pinnedFetchImpl = vi.fn(async ({ lookup }) => {
			const resolved = await new Promise<{ address: string; family: number }>(
				(resolve, reject) => {
					lookup("example.com", (error, address, family) => {
						if (error) {
							reject(error);
							return;
						}
						if (typeof address !== "string" || typeof family !== "number") {
							reject(new Error("expected single pinned address"));
							return;
						}
						resolve({ address, family });
					});
				},
			);
			expect(resolved).toEqual({ address: "93.184.216.34", family: 4 });
			return new Response("ok", { status: 200 });
		});

		const { response, release } = await fetchWithSsrfGuard({
			url: "https://example.com/resource",
			lookupFn,
			pinnedFetchImpl,
		});

		expect(response.status).toBe(200);
		expect(lookupCalls).toBe(1);
		expect(pinnedFetchImpl).toHaveBeenCalledTimes(1);
		expect(pinnedFetchImpl).toHaveBeenCalledWith(
			expect.objectContaining({
				addresses: ["93.184.216.34"],
				url: expect.objectContaining({ hostname: "example.com" }),
			}),
		);
		await release();
	});
});

/**
 * Redirects are followed manually (`redirect: "manual"`), so the guard itself
 * must reproduce standard fetch credential semantics: Authorization /
 * Proxy-Authorization / Cookie never follow a redirect to a different origin
 * (otherwise a malicious 302 exfiltrates the caller's bearer token), but they
 * DO survive same-origin redirects.
 */
describe("credential headers across redirects", () => {
	it("strips Authorization/Cookie on a cross-origin redirect, keeps other headers", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ url: String(input), headers: new Headers(init?.headers) });
				if (String(input).startsWith("https://api.example.com")) {
					return new Response(null, {
						status: 302,
						headers: { location: "https://evil.example.net/collect" },
					});
				}
				return new Response("ok", { status: 200 });
			},
		);
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://api.example.com/resource",
			fetchImpl,
			init: {
				headers: {
					authorization: "Bearer super-secret-token",
					"proxy-authorization": "Basic proxy-secret",
					cookie: "session=abc",
					accept: "application/json",
				},
			},
		});
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		// First hop (original origin) carries the credentials.
		expect(calls[0].headers.get("authorization")).toBe(
			"Bearer super-secret-token",
		);
		// Cross-origin hop must not receive them — but keeps benign headers.
		expect(calls[1].url).toBe("https://evil.example.net/collect");
		expect(calls[1].headers.get("authorization")).toBeNull();
		expect(calls[1].headers.get("proxy-authorization")).toBeNull();
		expect(calls[1].headers.get("cookie")).toBeNull();
		expect(calls[1].headers.get("accept")).toBe("application/json");
		await release();
	});

	it("does not restore stripped credentials if a redirect chain returns to the original origin", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ url: String(input), headers: new Headers(init?.headers) });
				if (String(input) === "https://api.example.com/start") {
					return new Response(null, {
						status: 302,
						headers: { location: "https://evil.example.net/bounce" },
					});
				}
				if (String(input) === "https://evil.example.net/bounce") {
					return new Response(null, {
						status: 302,
						headers: { location: "https://api.example.com/final" },
					});
				}
				return new Response("ok", { status: 200 });
			},
		);
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://api.example.com/start",
			fetchImpl,
			init: { headers: { authorization: "Bearer super-secret-token" } },
		});
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(3);
		expect(calls[0].headers.get("authorization")).toBe(
			"Bearer super-secret-token",
		);
		expect(calls[1].headers.get("authorization")).toBeNull();
		expect(calls[2].url).toBe("https://api.example.com/final");
		expect(calls[2].headers.get("authorization")).toBeNull();
		await release();
	});

	it("keeps Authorization on a same-origin redirect", async () => {
		const calls: Array<{ url: string; headers: Headers }> = [];
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({ url: String(input), headers: new Headers(init?.headers) });
				if (String(input) === "https://api.example.com/old") {
					return new Response(null, {
						status: 301,
						headers: { location: "/new" },
					});
				}
				return new Response("ok", { status: 200 });
			},
		);
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://api.example.com/old",
			fetchImpl,
			init: { headers: { authorization: "Bearer super-secret-token" } },
		});
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[1].url).toBe("https://api.example.com/new");
		expect(calls[1].headers.get("authorization")).toBe(
			"Bearer super-secret-token",
		);
		await release();
	});
});

/**
 * Redirects are followed manually (`redirect: "manual"`), so the guard must
 * also reproduce standard fetch method/body rewriting: on 303 (any non-GET/HEAD
 * method) and on 301/302 for POST, the follow-up request is rewritten to a
 * bodyless GET. Otherwise the request body — which may carry secrets — is
 * re-sent on every hop, including cross-origin hops to an attacker, and the
 * guard functionally deviates from the spec it claims to reproduce.
 */
describe("method + body across redirects", () => {
	it("rewrites a POST to a bodyless GET and does not re-send the body cross-origin (302)", async () => {
		const calls: Array<{
			url: string;
			method?: string;
			body?: BodyInit | null;
			contentType: string | null;
		}> = [];
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(input),
					method: init?.method,
					body: init?.body,
					contentType: new Headers(init?.headers).get("content-type"),
				});
				if (String(input).startsWith("https://api.example.com")) {
					return new Response(null, {
						status: 302,
						headers: { location: "https://evil.example.net/collect" },
					});
				}
				return new Response("ok", { status: 200 });
			},
		);
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://api.example.com/v1",
			fetchImpl,
			init: {
				method: "POST",
				body: '{"apiKey":"sk-secret"}',
				headers: {
					authorization: "Bearer t",
					"content-type": "application/json",
				},
			},
		});
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		// First hop carries the original POST + body.
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toBe('{"apiKey":"sk-secret"}');
		// Cross-origin hop must be a bodyless GET — no secret body leaked, and the
		// content-type body header is dropped too.
		expect(calls[1].url).toBe("https://evil.example.net/collect");
		expect((calls[1].method ?? "GET").toUpperCase()).toBe("GET");
		expect(calls[1].body ?? null).toBeNull();
		expect(calls[1].contentType).toBeNull();
		await release();
	});

	it("rewrites a same-origin 303 POST to a bodyless GET (spec 303 semantics)", async () => {
		const calls: Array<{
			url: string;
			method?: string;
			body?: BodyInit | null;
		}> = [];
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(input),
					method: init?.method,
					body: init?.body,
				});
				if (String(input) === "https://api.example.com/submit") {
					return new Response(null, {
						status: 303,
						headers: { location: "/result" },
					});
				}
				return new Response("ok", { status: 200 });
			},
		);
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://api.example.com/submit",
			fetchImpl,
			init: { method: "POST", body: "payload=1" },
		});
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[1].url).toBe("https://api.example.com/result");
		expect((calls[1].method ?? "GET").toUpperCase()).toBe("GET");
		expect(calls[1].body ?? null).toBeNull();
		await release();
	});

	it("preserves method and body across a 307 redirect (method-preserving status)", async () => {
		const calls: Array<{
			url: string;
			method?: string;
			body?: BodyInit | null;
		}> = [];
		const fetchImpl = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				calls.push({
					url: String(input),
					method: init?.method,
					body: init?.body,
				});
				if (String(input) === "https://api.example.com/old") {
					return new Response(null, {
						status: 307,
						headers: { location: "/new" },
					});
				}
				return new Response("ok", { status: 200 });
			},
		);
		const { response, release } = await fetchWithSsrfGuard({
			url: "https://api.example.com/old",
			fetchImpl,
			init: { method: "POST", body: "keep-me" },
		});
		expect(response.status).toBe(200);
		expect(calls).toHaveLength(2);
		expect(calls[1].url).toBe("https://api.example.com/new");
		expect(calls[1].method).toBe("POST");
		expect(calls[1].body).toBe("keep-me");
		await release();
	});
});
