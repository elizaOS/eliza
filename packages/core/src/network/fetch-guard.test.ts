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
