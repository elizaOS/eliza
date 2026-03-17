import { beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxTokenManager } from "../../security/sandbox-token-manager";
import {
	createSandboxFetchProxy,
	type SandboxFetchAuditEvent,
} from "../sandbox-fetch-proxy";

describe("createSandboxFetchProxy", () => {
	let tm: SandboxTokenManager;
	let auditEvents: SandboxFetchAuditEvent[];

	beforeEach(() => {
		tm = new SandboxTokenManager();
		auditEvents = [];
	});

	function createMockFetch(
		responseBody = "{}",
		responseHeaders: Record<string, string> = {},
		status = 200,
	): typeof fetch {
		return vi.fn().mockResolvedValue(
			new Response(responseBody, {
				status,
				headers: { "content-type": "application/json", ...responseHeaders },
			}),
		);
	}

	function makeProxy(
		baseFetch: typeof fetch,
		failureMode: "fail-closed" | "fail-open" = "fail-closed",
	) {
		return createSandboxFetchProxy({
			tokenManager: tm,
			baseFetch,
			onAuditEvent: (e) => auditEvents.push(e),
			failureMode,
		});
	}

	describe("outbound detokenization", () => {
		it("should replace tokens in URL", async () => {
			const token = tm.registerSecret("API_KEY", "sk-real-key");
			const mockFetch = createMockFetch();
			const proxy = makeProxy(mockFetch);

			await proxy(`https://api.example.com?key=${token}`);

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.example.com?key=sk-real-key",
				undefined,
			);
		});

		it("should replace tokens in Authorization header", async () => {
			const token = tm.registerSecret("API_KEY", "sk-real-key");
			const mockFetch = createMockFetch();
			const proxy = makeProxy(mockFetch);

			await proxy("https://api.example.com", {
				headers: { Authorization: `Bearer ${token}` },
			});

			const call = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
			const init = call[1] as RequestInit;
			const headers = init.headers as Record<string, string>;
			expect(headers.Authorization).toBe("Bearer sk-real-key");
		});

		it("should replace tokens in JSON body", async () => {
			const token = tm.registerSecret("API_KEY", "sk-real-key");
			const mockFetch = createMockFetch();
			const proxy = makeProxy(mockFetch);

			await proxy("https://api.example.com", {
				method: "POST",
				body: JSON.stringify({ apiKey: token }),
			});

			const call = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
			const init = call[1] as RequestInit;
			expect(JSON.parse(init.body as string).apiKey).toBe("sk-real-key");
		});

		it("should not modify request when no tokens present", async () => {
			const mockFetch = createMockFetch();
			const proxy = makeProxy(mockFetch);

			await proxy("https://api.example.com", {
				headers: { "Content-Type": "application/json" },
				body: '{"key": "not-a-token"}',
			});

			const call = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(call[0]).toBe("https://api.example.com");
		});

		it("should emit audit event for outbound replacement", async () => {
			const token = tm.registerSecret("KEY", "secret-value");
			const mockFetch = createMockFetch();
			const proxy = makeProxy(mockFetch);

			await proxy("https://api.example.com", {
				headers: { "x-api-key": token },
			});

			const outbound = auditEvents.filter((e) => e.direction === "outbound");
			expect(outbound.length).toBeGreaterThanOrEqual(1);
			expect(outbound[0].replacementCount).toBe(1);
			expect(outbound[0].tokenIds).toHaveLength(1);
		});
	});

	describe("inbound sanitization", () => {
		it("should replace leaked secrets in response body", async () => {
			tm.registerSecret("KEY", "sk-leaked-in-response");
			const mockFetch = createMockFetch(
				'{"error": "Invalid key: sk-leaked-in-response"}',
			);
			const proxy = makeProxy(mockFetch);

			const response = await proxy("https://api.example.com");
			const body = await response.text();

			expect(body).not.toContain("sk-leaked-in-response");
			expect(body).toContain("stok_");
		});

		it("should replace secrets in Set-Cookie header", async () => {
			const _token = tm.registerSecret("KEY", "secret-session-value");
			const mockFetch = createMockFetch("{}", {
				"set-cookie": "session=secret-session-value; Path=/",
			});
			const proxy = makeProxy(mockFetch);

			const response = await proxy("https://api.example.com");
			const cookie = response.headers.get("set-cookie");

			expect(cookie).not.toContain("secret-session-value");
		});

		it("should not scan binary responses", async () => {
			tm.registerSecret("KEY", "secret-value");
			const mockFetch = vi.fn().mockResolvedValue(
				new Response(Buffer.from("binary data with secret-value"), {
					headers: { "content-type": "application/octet-stream" },
				}),
			);
			const proxy = makeProxy(mockFetch);

			const response = await proxy("https://api.example.com");
			// Binary response should pass through unchanged
			expect(response.headers.get("content-type")).toBe(
				"application/octet-stream",
			);
		});

		it("should skip scanning large responses", async () => {
			tm.registerSecret("KEY", "secret");
			const mockFetch = vi.fn().mockResolvedValue(
				new Response("x", {
					headers: {
						"content-type": "application/json",
						"content-length": "999999999",
					},
				}),
			);
			const proxy = createSandboxFetchProxy({
				tokenManager: tm,
				baseFetch: mockFetch,
				maxResponseScanBytes: 1000,
			});

			const response = await proxy("https://api.example.com");
			// Should pass through without scanning
			expect(response).toBeTruthy();
		});
	});

	describe("failure modes", () => {
		it("fail-closed should throw on detokenization error", async () => {
			const brokenTm = new SandboxTokenManager();
			brokenTm.detokenizeString = () => {
				throw new Error("deliberate error");
			};
			const token = brokenTm.registerSecret("KEY", "val");

			const proxy = createSandboxFetchProxy({
				tokenManager: brokenTm,
				baseFetch: createMockFetch(),
				failureMode: "fail-closed",
			});

			await expect(
				proxy(`https://api.example.com?key=${token}`),
			).rejects.toThrow(/outbound detokenization failed/i);
		});

		it("fail-closed should throw when inbound sanitization fails", async () => {
			tm.registerSecret("KEY", "secret");
			const brokenResponse = {
				clone: () => {
					throw new Error("clone failed");
				},
				headers: new Headers({ "content-type": "application/json" }),
				status: 200,
				statusText: "OK",
				url: "https://api.example.com",
			} as Response;
			const mockFetch = vi.fn().mockResolvedValue(brokenResponse);

			const proxy = createSandboxFetchProxy({
				tokenManager: tm,
				baseFetch: mockFetch,
				failureMode: "fail-closed",
			});

			await expect(proxy("https://api.example.com")).rejects.toThrow(
				/inbound sanitization failed/i,
			);
		});

		it("fail-open should pass through when inbound sanitization fails", async () => {
			tm.registerSecret("KEY", "secret");
			const brokenResponse = {
				clone: () => {
					throw new Error("clone failed");
				},
				headers: new Headers({ "content-type": "application/json" }),
				status: 200,
				statusText: "OK",
				url: "https://api.example.com",
			} as Response;
			const mockFetch = vi.fn().mockResolvedValue(brokenResponse);
			const proxy = makeProxy(mockFetch, "fail-open");

			const response = await proxy("https://api.example.com");
			expect(response).toBe(brokenResponse);

			const inboundError = auditEvents.find(
				(event) => event.direction === "inbound" && event.error,
			);
			expect(inboundError).toBeDefined();
		});

		it("should pass through when no secrets are registered", async () => {
			const mockFetch = createMockFetch('{"status": "ok"}');
			const proxy = makeProxy(mockFetch);

			const response = await proxy("https://api.example.com");
			const body = await response.text();
			expect(body).toBe('{"status": "ok"}');
		});
	});

	describe("Headers format handling", () => {
		it("should handle Headers object", async () => {
			const token = tm.registerSecret("KEY", "secret");
			const mockFetch = createMockFetch();
			const proxy = makeProxy(mockFetch);

			const headers = new Headers();
			headers.set("Authorization", `Bearer ${token}`);

			await proxy("https://api.example.com", { headers });

			const call = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
			const init = call[1] as RequestInit;
			const resolvedHeaders = init.headers as Record<string, string>;
			expect(
				resolvedHeaders.Authorization || resolvedHeaders.authorization,
			).toBe("Bearer secret");
		});

		it("should handle array-style headers", async () => {
			const token = tm.registerSecret("KEY", "secret");
			const mockFetch = createMockFetch();
			const proxy = makeProxy(mockFetch);

			await proxy("https://api.example.com", {
				headers: [["Authorization", `Bearer ${token}`]],
			});

			const call = (mockFetch as ReturnType<typeof vi.fn>).mock.calls[0];
			const init = call[1] as RequestInit;
			const resolvedHeaders = init.headers as Record<string, string>;
			expect(resolvedHeaders.Authorization).toBe("Bearer secret");
		});
	});
});
