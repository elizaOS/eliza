/**
 * processAttachments attachment-fetch deadline: every local/remote document/image
 * fetch must be bounded and the same signal must remain active through
 * response.arrayBuffer()/text() so a stalled body is still aborted. Caller
 * cancellation is composed via AbortSignal.any.
 */
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentType } from "../../types/primitives.ts";
import {
	DEFAULT_BASIC_CAPABILITIES_ATTACHMENT_FETCH_TIMEOUT_MS,
	processAttachments,
} from "./index.ts";

function stallUntilAborted(signal?: AbortSignal): Promise<Response> {
	return new Promise<Response>((_resolve, reject) => {
		if (!signal) return;
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		signal.addEventListener("abort", () => reject(signal.reason), {
			once: true,
		});
	});
}

function stalledTextResponse(signal?: AbortSignal): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Headers({ "content-type": "text/plain" }),
		text: () => stallUntilAborted(signal).then(() => "hello"),
		arrayBuffer: () => stallUntilAborted(signal).then(() => new ArrayBuffer(0)),
	} as unknown as Response;
}

function stalledArrayBufferResponse(signal?: AbortSignal): Response {
	return {
		ok: true,
		status: 200,
		statusText: "OK",
		headers: new Headers({ "content-type": "application/octet-stream" }),
		arrayBuffer: () => stallUntilAborted(signal).then(() => new ArrayBuffer(8)),
		text: () => Promise.resolve(""),
	} as unknown as Response;
}

function makeRuntime() {
	return {
		agentId: "test-agent",
		character: { name: "Test" },
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
		getSetting: vi.fn().mockReturnValue(undefined),
	} as unknown as import("../../types/index.ts").IAgentRuntime;
}

function makeDocumentAttachment(url = "https://example.com/doc.txt") {
	return {
		url,
		contentType: ContentType.DOCUMENT,
		text: undefined,
		title: undefined,
	} as unknown as import("../../types/index.ts").Media;
}

function makeImageAttachment(url = "/local/image.jpg") {
	return {
		url,
		contentType: ContentType.IMAGE,
		description: undefined,
		title: undefined,
	} as unknown as import("../../types/index.ts").Media;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("processAttachments attachment fetch timeout", () => {
	it("exposes DEFAULT_BASIC_CAPABILITIES_ATTACHMENT_FETCH_TIMEOUT_MS === 10_000", () => {
		expect(DEFAULT_BASIC_CAPABILITIES_ATTACHMENT_FETCH_TIMEOUT_MS).toBe(10_000);
	});

	it("passes AbortSignal.timeout budget to fetch for DOCUMENT (hanging fetch → TimeoutError)", async () => {
		const origTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation((_ms: number) => origTimeout(10));
		const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
			stallUntilAborted(init?.signal),
		);
		await expect(
			processAttachments([makeDocumentAttachment()], makeRuntime(), {
				fetchImpl: fetchSpy as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(timeoutSpy).toHaveBeenCalledWith(
			DEFAULT_BASIC_CAPABILITIES_ATTACHMENT_FETCH_TIMEOUT_MS,
		);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const init = fetchSpy.mock.calls[0][1] as RequestInit;
		expect(init.signal).toBeDefined();
		expect(init.signal?.aborted).toBe(true);
	});

	it("passes AbortSignal.timeout budget to fetch for IMAGE local (hanging fetch → TimeoutError)", async () => {
		const origTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) =>
			origTimeout(10),
		);
		const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
			stallUntilAborted(init?.signal),
		);
		await expect(
			processAttachments(
				[makeImageAttachment("/local/image.jpg")],
				makeRuntime(),
				{
					fetchImpl: fetchSpy as unknown as typeof fetch,
				},
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});

	it("aborts stalled response.text() body via same timeout signal (DOCUMENT text)", async () => {
		const origTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) =>
			origTimeout(10),
		);
		const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
			stalledTextResponse(init?.signal),
		);
		await expect(
			processAttachments([makeDocumentAttachment()], makeRuntime(), {
				fetchImpl: fetchSpy as unknown as typeof fetch,
			}),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("aborts stalled response.arrayBuffer() body via same timeout signal (IMAGE)", async () => {
		const origTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) =>
			origTimeout(10),
		);
		const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
			stalledArrayBufferResponse(init?.signal),
		);
		await expect(
			processAttachments(
				[makeImageAttachment("/local/pic.png")],
				makeRuntime(),
				{
					fetchImpl: fetchSpy as unknown as typeof fetch,
				},
			),
		).rejects.toMatchObject({ name: "TimeoutError" });
	});

	it("merges caller signal via AbortSignal.any when provided", async () => {
		const origTimeout = AbortSignal.timeout.bind(AbortSignal);
		const timeoutSpy = vi
			.spyOn(AbortSignal, "timeout")
			.mockImplementation((_ms: number) => origTimeout(10));
		const anySpy = vi.spyOn(AbortSignal, "any");
		const callerCtrl = new AbortController();
		const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
			stallUntilAborted(init?.signal),
		);
		const pending = processAttachments(
			[makeDocumentAttachment()],
			makeRuntime(),
			{
				fetchImpl: fetchSpy as unknown as typeof fetch,
				signal: callerCtrl.signal,
			},
		);
		callerCtrl.abort(new DOMException("caller abort", "AbortError"));
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		expect(timeoutSpy).toHaveBeenCalledWith(
			DEFAULT_BASIC_CAPABILITIES_ATTACHMENT_FETCH_TIMEOUT_MS,
		);
		expect(anySpy).toHaveBeenCalled();
		const anyArgs = anySpy.mock.calls[0][0] as AbortSignal[];
		expect(anyArgs).toHaveLength(2);
		expect(anyArgs[0]).toBe(callerCtrl.signal);
	});

	it("succeeds when fetch returns valid document within budget", async () => {
		const fetchSpy = vi
			.fn()
			.mockResolvedValue(
				new Response("hello from doc", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
			);
		const out = await processAttachments(
			[makeDocumentAttachment("https://example.com/doc2.txt")],
			makeRuntime(),
			{ fetchImpl: fetchSpy as unknown as typeof fetch },
		);
		expect(out).toHaveLength(1);
		expect(out[0].text).toBe("hello from doc");
	});

	describe("timeoutMs validation", () => {
		for (const bad of [
			NaN,
			Infinity,
			-Infinity,
			-1,
			0,
			1.5,
			Number.NaN,
		]) {
			it(`rejects invalid timeoutMs=${String(bad)}`, async () => {
				await expect(
					processAttachments([makeDocumentAttachment()], makeRuntime(), {
						timeoutMs: bad as number,
						fetchImpl: vi.fn() as unknown as typeof fetch,
					}),
				).rejects.toThrow(TypeError);
			});
		}

		it("accepts valid integer timeoutMs", async () => {
			const fetchSpy = vi.fn().mockResolvedValue(
				new Response("ok", {
					status: 200,
					headers: { "content-type": "text/plain" },
				}),
			);
			const out = await processAttachments(
				[makeDocumentAttachment()],
				makeRuntime(),
				{ timeoutMs: 5000, fetchImpl: fetchSpy as unknown as typeof fetch },
			);
			expect(out[0].text).toBe("ok");
		});

		it("respects tiny bound via validated timeoutMs (real fetch timeout)", async () => {
			// Use a tiny timeoutMs to prove the bound is honored
			const origTimeout = AbortSignal.timeout.bind(AbortSignal);
			let capturedMs = -1;
			vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
				capturedMs = ms;
				return origTimeout(ms);
			});
			const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) =>
				stallUntilAborted(init?.signal),
			);
			await expect(
				processAttachments([makeDocumentAttachment()], makeRuntime(), {
					timeoutMs: 15,
					fetchImpl: fetchSpy as unknown as typeof fetch,
				}),
			).rejects.toMatchObject({ name: "TimeoutError" });
			expect(capturedMs).toBe(15);
		});
	});

	describe("real transport — headers then stalled body", () => {
		it("aborts stalled body via real http server with timeoutMs", async () => {
			const server = createServer((_req, res) => {
				// Send headers immediately, then stall body forever
				res.writeHead(200, { "content-type": "text/plain" });
				res.write("partial-");
				// never call res.end() — body stalls
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
			const addr = server.address() as { port: number };
			const url = `http://127.0.0.1:${addr.port}/doc.txt`;

			try {
				await expect(
					processAttachments(
						[makeDocumentAttachment(url)],
						makeRuntime(),
						{ timeoutMs: 25 },
					),
				).rejects.toMatchObject({ name: "TimeoutError" });
			} finally {
				await new Promise<void>((r) => server.close(() => r()));
			}
		});

		it("succeeds via real http server when body returns within budget", async () => {
			const server = createServer((_req, res) => {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("hello real transport");
			});
			await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
			const addr = server.address() as { port: number };
			const url = `http://127.0.0.1:${addr.port}/doc.txt`;
			try {
				const out = await processAttachments(
					[makeDocumentAttachment(url)],
					makeRuntime(),
				);
				expect(out[0].text).toBe("hello real transport");
			} finally {
				await new Promise<void>((r) => server.close(() => r()));
			}
		});
	});
});
