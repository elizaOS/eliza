/**
 * Credential-probe boundary tests use deterministic fetch responses to verify
 * deadlines, redirect policy, bounded bodies, response schemas, and secret-free
 * failure translation without contacting third-party services.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getPreset } from "./setup-credentials";

function preset(name: string) {
	const value = getPreset(name);
	if (!value) throw new Error(`Missing preset ${name}`);
	return value;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("credential probe network boundary", () => {
	it.each([
		["github", { token: "github-secret" }, "https://api.github.com/user"],
		[
			"vercel",
			{ token: "vercel-secret" },
			"https://api.vercel.com/v9/projects",
		],
		[
			"cloudflare",
			{ apiKey: "cloudflare-secret", email: "owner@example.com" },
			"https://api.cloudflare.com/client/v4/zones",
		],
		[
			"anthropic",
			{ apiKey: "anthropic-secret" },
			"https://api.anthropic.com/v1/messages",
		],
		["openai", { apiKey: "openai-secret" }, "https://api.openai.com/v1/models"],
		["fal", { apiKey: "fal-secret" }, "https://rest.fal.run/fal-ai/fast-sdxl"],
	])(
		"fences %s redirects and supplies a deadline",
		async (name, credentials, url) => {
			const fetchMock = vi.fn(
				async (_url: string | URL | Request, init?: RequestInit) => {
					expect(init?.redirect).toBe("error");
					expect(init?.signal).toBeInstanceOf(AbortSignal);
					if (name === "github") return Response.json({ login: "octocat" });
					if (name === "vercel") return Response.json({ projects: [] });
					if (name === "cloudflare") {
						return Response.json({ success: true, result: [] });
					}
					return new Response(null, { status: 204 });
				},
			);
			vi.stubGlobal("fetch", fetchMock);

			const result = await preset(name).validate(credentials);

			expect(result.valid).toBe(true);
			expect(fetchMock).toHaveBeenCalledWith(
				url,
				expect.objectContaining({ redirect: "error" }),
			);
		},
	);

	it("rejects an oversized declared JSON response before parsing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response("{}", {
						headers: {
							"content-type": "application/json",
							"content-length": String(64 * 1024 + 1),
						},
					}),
			),
		);

		await expect(
			preset("github").validate({ token: "secret" }),
		).resolves.toEqual({
			valid: false,
			error: "GitHub returned an invalid response",
		});
	});

	it("rejects a streamed response that crosses the body cap", async () => {
		const chunk = new Uint8Array(33 * 1024);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(chunk);
								controller.enqueue(chunk);
								controller.close();
							},
						}),
						{ headers: { "content-type": "application/json" } },
					),
			),
		);

		const result = await preset("github").validate({ token: "secret" });

		expect(result).toEqual({
			valid: false,
			error: "GitHub returned an invalid response",
		});
	});

	it("requires JSON media types and the provider's success schema", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response("{}", { headers: { "content-type": "text/plain" } }),
			)
			.mockResolvedValueOnce(Response.json({ projects: "not-an-array" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			preset("github").validate({ token: "secret" }),
		).resolves.toEqual({
			valid: false,
			error: "GitHub returned an invalid response",
		});
		await expect(
			preset("vercel").validate({ token: "secret" }),
		).resolves.toEqual({
			valid: false,
			error: "Vercel returned an invalid response",
		});
	});

	it("rejects missing, oversized, and header-breaking credentials before fetch", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(preset("github").validate({})).resolves.toEqual({
			valid: false,
			error: "GitHub returned an invalid response",
		});
		await expect(
			preset("openai").validate({ apiKey: "x".repeat(16 * 1024 + 1) }),
		).resolves.toEqual({
			valid: false,
			error: "OpenAI returned an invalid response",
		});
		await expect(
			preset("cloudflare").validate({
				apiKey: "key",
				email: "owner@example.com\r\nx-leak: secret",
			}),
		).resolves.toEqual({
			valid: false,
			error: "Cloudflare returned an invalid response",
		});
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("does not mistake throttling or request validation for authenticated success", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(new Response(null, { status: 429 }))
				.mockResolvedValueOnce(new Response(null, { status: 429 }))
				.mockResolvedValueOnce(new Response(null, { status: 422 })),
		);

		await expect(
			preset("anthropic").validate({ apiKey: "secret" }),
		).resolves.toEqual({ valid: false, error: "Anthropic returned 429" });
		await expect(
			preset("openai").validate({ apiKey: "secret" }),
		).resolves.toEqual({ valid: false, error: "OpenAI returned 429" });
		await expect(preset("fal").validate({ apiKey: "secret" })).resolves.toEqual(
			{ valid: false, error: "fal.ai returned 422" },
		);
	});

	it("requires provider identity fields instead of accepting empty success envelopes", async () => {
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValueOnce(Response.json({}))
				.mockResolvedValueOnce(Response.json({ success: false, result: [] })),
		);

		await expect(
			preset("github").validate({ token: "secret" }),
		).resolves.toEqual({
			valid: false,
			error: "GitHub returned an invalid response",
		});
		await expect(
			preset("cloudflare").validate({
				apiKey: "secret",
				email: "owner@example.com",
			}),
		).resolves.toEqual({
			valid: false,
			error: "Cloudflare returned an invalid response",
		});
	});

	it("does not expose provider, transport, or credential text from failures", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error(
					"request with super-secret-token failed at internal.proxy",
				);
			}),
		);

		const result = await preset("openai").validate({
			apiKey: "super-secret-token",
		});

		expect(result).toEqual({
			valid: false,
			error: "Unable to reach OpenAI credential service",
		});
		expect(result.error).not.toContain("secret");
		expect(result.error).not.toContain("internal.proxy");
	});

	it("preserves timeout identity without exposing the abort reason", async () => {
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(
			AbortSignal.abort(
				new DOMException("sensitive upstream detail", "TimeoutError"),
			),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
				throw init?.signal?.reason;
			}),
		);

		await expect(
			preset("anthropic").validate({ apiKey: "secret" }),
		).resolves.toEqual({
			valid: false,
			error: "Anthropic credential validation timed out",
		});
	});

	it("applies the deadline through body reads even when stream cancellation hangs", async () => {
		const controller = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							pull() {},
							cancel: () => new Promise<void>(() => undefined),
						}),
						{ headers: { "content-type": "application/json" } },
					),
			),
		);
		setTimeout(
			() =>
				controller.abort(new DOMException("private detail", "TimeoutError")),
			0,
		);

		await expect(
			preset("vercel").validate({ token: "secret" }),
		).resolves.toEqual({
			valid: false,
			error: "Vercel credential validation timed out",
		});
	});

	it("cancels status-only response bodies without buffering them", async () => {
		let cancelled = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							pull() {},
							cancel() {
								cancelled = true;
							},
						}),
						{ status: 429 },
					),
			),
		);

		await expect(preset("fal").validate({ apiKey: "secret" })).resolves.toEqual(
			{
				valid: false,
				error: "fal.ai returned 429",
			},
		);
		expect(cancelled).toBe(true);
	});
});
