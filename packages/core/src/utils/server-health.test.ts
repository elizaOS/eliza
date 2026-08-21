/**
 * Deterministic tests for server-health URL construction and transport outcomes.
 * URL behavior is observed through the public ping boundary with a mocked fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { pingServer, ServerHealthError } from "./server-health.js";

describe("server health utilities", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	describe("ServerHealthError", () => {
		it("constructs error with correct properties and cause", () => {
			const causeErr = new Error("Connection refused");
			const err = new ServerHealthError(
				"Server timed out",
				"http://localhost:3000/health",
				causeErr,
			);

			expect(err.name).toBe("ServerHealthError");
			expect(err.message).toBe("Server timed out");
			expect(err.url).toBe("http://localhost:3000/health");
			expect(err.cause).toBe(causeErr);
		});
	});

	describe("pingServer", () => {
		it.each([
			[{ port: 3000 }, "http://localhost:3000/api/agents"],
			[{ port: 3000, endpoint: "health" }, "http://localhost:3000/health"],
			[
				{ port: 3000, endpoint: "api/v1/status" },
				"http://localhost:3000/api/v1/status",
			],
			[
				{ port: 3000, endpoint: "/custom/health" },
				"http://localhost:3000/custom/health",
			],
			[
				{
					port: 8443,
					host: "api.eliza.local",
					protocol: "https" as const,
					endpoint: "/ready",
				},
				"https://api.eliza.local:8443/ready",
			],
		])("requests the normalized URL for %j", async (options, expectedUrl) => {
			const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
			globalThis.fetch = fetchMock;

			expect(await pingServer(options)).toBe(true);
			expect(fetchMock).toHaveBeenCalledWith(expectedUrl, {
				signal: expect.any(AbortSignal),
			});
		});

		it("returns true when fetch responds with 2xx ok", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: true,
			} as Response);

			const result = await pingServer({ port: 3000, requestTimeout: 500 });
			expect(result).toBe(true);
		});

		it("returns false when fetch responds with non-2xx status", async () => {
			globalThis.fetch = vi.fn().mockResolvedValue({
				ok: false,
				status: 503,
			} as Response);

			const result = await pingServer({ port: 3000, requestTimeout: 500 });
			expect(result).toBe(false);
		});

		it("returns false when fetch rejects with network error", async () => {
			globalThis.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

			const result = await pingServer({ port: 3000, requestTimeout: 500 });
			expect(result).toBe(false);
		});
	});
});
