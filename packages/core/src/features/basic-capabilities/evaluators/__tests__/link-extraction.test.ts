/**
 * Unit coverage for the link-extraction evaluator (`linkExtractionEvaluator`):
 * URL gating, preview fetch/summarize, dedupe and trailing-punctuation
 * stripping, platform stamping, and output parsing. The harness is fully
 * deterministic — a hand-mocked runtime with a `vi.fn` `useModel` and the
 * link-preview fetch driven through the REAL SSRF guard over an injected
 * transport (`_setLinkPreviewTransportForTests`), with no real network, model,
 * or database. The guard's node-pinned transport bypasses a stubbed
 * `globalThis.fetch` by design, so the deterministic wire is injected instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	EvaluatorRunContext,
	Memory,
	State,
	UUID,
} from "../../../../types/index.ts";
import { ModelType } from "../../../../types/index.ts";
import {
	_setLinkPreviewTransportForTests,
	linkExtractionEvaluator,
} from "../link-extraction.ts";

const AGENT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const ENTITY_ID = "00000000-0000-0000-0000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-0000-0000-000000000003" as UUID;
const MESSAGE_ID = "00000000-0000-0000-0000-0000000000aa" as UUID;

type MockRuntime = {
	agentId: UUID;
	character: { name: string };
	useModel: ReturnType<typeof vi.fn>;
	createMemory: ReturnType<typeof vi.fn>;
	getService: ReturnType<typeof vi.fn>;
	logger: {
		debug: ReturnType<typeof vi.fn>;
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
		error: ReturnType<typeof vi.fn>;
		trace: ReturnType<typeof vi.fn>;
	};
};

function makeRuntime(
	useModelImpl: (modelType: string, params: unknown) => Promise<unknown>,
): MockRuntime {
	return {
		agentId: AGENT_ID,
		character: { name: "TestAgent" },
		useModel: vi.fn(useModelImpl),
		createMemory: vi.fn(async () => "00000000-0000-0000-0000-0000000000ff"),
		getService: vi.fn(() => undefined),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			trace: vi.fn(),
		},
	};
}

function makeMessage(text: string, source?: string): Memory {
	return {
		id: MESSAGE_ID,
		entityId: ENTITY_ID,
		agentId: AGENT_ID,
		roomId: ROOM_ID,
		content: source ? { text, source } : { text },
		createdAt: Date.now(),
	} as Memory;
}

function makeContext(
	runtime: MockRuntime,
	message: Memory,
): EvaluatorRunContext {
	return {
		runtime: runtime as unknown as EvaluatorRunContext["runtime"],
		message,
		options: {},
	};
}

function makeFetchResponse(
	body: string,
	{ contentType = "text/html; charset=utf-8", ok = true } = {},
): Response {
	return {
		ok,
		status: ok ? 200 : 500,
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "content-type" ? contentType : null,
		},
		async text() {
			return body;
		},
	} as unknown as Response;
}

// A public pinned address so the guard's SSRF check passes and the injected
// transport (never the real network) serves the deterministic response.
const PINNED_LOOKUP = async () => [{ address: "93.184.216.34", family: 4 }];

/** Drive the preview fetch to `response` through the real guard. */
function stubPreviewFetch(response: Response): void {
	_setLinkPreviewTransportForTests({
		lookupFn: PINNED_LOOKUP,
		pinnedFetchImpl: async () => response,
		fetchImpl: async () => response,
	});
}

/** Drive the preview fetch to throw at the transport (network failure). */
function stubPreviewFetchFailure(error: Error): void {
	_setLinkPreviewTransportForTests({
		lookupFn: PINNED_LOOKUP,
		pinnedFetchImpl: async () => {
			throw error;
		},
		fetchImpl: async () => {
			throw error;
		},
	});
}

describe("linkExtractionEvaluator", () => {
	afterEach(() => {
		_setLinkPreviewTransportForTests(undefined);
		vi.restoreAllMocks();
	});

	it("shouldRun is false when the message has no URL", async () => {
		const runtime = makeRuntime(async () => "");
		const message = makeMessage("hello there");
		const result = await linkExtractionEvaluator.shouldRun(
			makeContext(runtime, message),
		);
		expect(result).toBe(false);
	});

	it("shouldRun is true when the message contains an http URL", async () => {
		const runtime = makeRuntime(async () => "");
		const message = makeMessage("check this https://example.com/x out");
		const result = await linkExtractionEvaluator.shouldRun(
			makeContext(runtime, message),
		);
		expect(result).toBe(true);
	});

	it("prepare extracts a URL, summarizes via TEXT_SMALL, and persists a link memory", async () => {
		stubPreviewFetch(
			makeFetchResponse(
				"<html><head><title>Example Domain &amp; Friends</title></head><body><p>This domain is for use in examples.</p></body></html>",
			),
		);

		const runtime = makeRuntime(async (modelType, params) => {
			expect(modelType).toBe(ModelType.TEXT_SMALL);
			expect((params as { prompt: string }).prompt).toContain(
				"https://example.com/article",
			);
			return "Example Domain & Friends — a short page used for documentation examples.";
		});
		const message = makeMessage(
			"please check https://example.com/article and tell me",
		);
		const context = {
			...makeContext(runtime, message),
			state: { values: {}, data: {}, text: "" } as State,
		};
		const prepared = await linkExtractionEvaluator.prepare?.(context);

		expect(prepared?.links).toHaveLength(1);
		expect(prepared?.links[0]?.url).toBe("https://example.com/article");
		expect(prepared?.links[0]?.title).toBe("Example Domain & Friends");
		expect(prepared?.links[0]?.summary).toContain("Example Domain");

		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
		const [memory, tableName] = runtime.createMemory.mock.calls[0] as [
			Memory,
			string,
			boolean,
		];
		expect(tableName).toBe("links");
		expect(memory.content.type).toBe("link");
		expect(memory.content.url).toBe("https://example.com/article");
		expect((memory.metadata as Record<string, unknown>).url).toBe(
			"https://example.com/article",
		);
		expect((memory.metadata as Record<string, unknown>).tags).toEqual(
			expect.arrayContaining(["link", "auto_capture"]),
		);
	});

	it("decodes title entities once and strips browser-tokenized raw-text tags", async () => {
		stubPreviewFetch(
			makeFetchResponse(
				"<title>&amp;lt;literal&amp;gt;</title><body>safe<script>steal()</script:lookalike>still-script</sCrIpT data-x=1><style>hidden{}</style=lookalike>still-style</style/ignored><p>after</p><script>unclosed",
			),
		);
		const runtime = makeRuntime(async (_modelType, params) => {
			const prompt = (params as { prompt: string }).prompt;
			expect(prompt).toContain("Title: &lt;literal&gt;");
			expect(prompt).toContain("safe");
			expect(prompt).not.toContain("steal()");
			expect(prompt).not.toContain("still-script");
			expect(prompt).not.toContain("hidden{}");
			expect(prompt).not.toContain("still-style");
			expect(prompt).not.toContain("unclosed");
			expect(prompt).toContain("after");
			return "summary";
		});
		const context = {
			...makeContext(runtime, makeMessage("see https://example.com/hostile")),
			state: { values: {}, data: {}, text: "" } as State,
		};

		const prepared = await linkExtractionEvaluator.prepare?.(context);

		expect(prepared?.links[0]?.title).toBe("&lt;literal&gt;");
	});

	it("prepare dedupes repeated URLs and strips trailing punctuation", async () => {
		stubPreviewFetch(
			makeFetchResponse("<html><title>doc</title><body>x</body></html>"),
		);

		const runtime = makeRuntime(async () => "ok summary");
		const message = makeMessage(
			"see https://a.example.com/page. also https://a.example.com/page (again).",
		);
		const context = {
			...makeContext(runtime, message),
			state: { values: {}, data: {}, text: "" } as State,
		};
		const prepared = await linkExtractionEvaluator.prepare?.(context);
		expect(prepared?.links).toHaveLength(1);
		expect(prepared?.links[0]?.url).toBe("https://a.example.com/page");
	});

	it("prepare persists the URL even when fetch fails (no title/summary)", async () => {
		stubPreviewFetchFailure(new Error("network down"));

		const runtime = makeRuntime(async () => "should not be called");
		const message = makeMessage("look https://unreachable.test/page");
		const context = {
			...makeContext(runtime, message),
			state: { values: {}, data: {}, text: "" } as State,
		};
		const prepared = await linkExtractionEvaluator.prepare?.(context);

		expect(prepared?.links).toHaveLength(1);
		expect(prepared?.links[0]?.url).toBe("https://unreachable.test/page");
		expect(prepared?.links[0]?.title).toBe("");
		expect(prepared?.links[0]?.summary).toBe("");
		// TEXT_SMALL should not be called when fetch fails.
		expect(runtime.useModel).not.toHaveBeenCalled();
		// Memory still persisted with raw URL.
		expect(runtime.createMemory).toHaveBeenCalledTimes(1);
	});

	it.each([
		["discord", "https://example.com/d"],
		["twitter", "https://example.com/t"],
	])(
		"stamps the originating platform %s on the persisted link memory",
		async (platform, url) => {
			stubPreviewFetch(
				makeFetchResponse("<html><title>doc</title><body>x</body></html>"),
			);

			const runtime = makeRuntime(async () => "summary");
			const message = makeMessage(`shared ${url}`, platform);
			const context = {
				...makeContext(runtime, message),
				state: { values: {}, data: {}, text: "" } as State,
			};
			await linkExtractionEvaluator.prepare?.(context);

			expect(runtime.createMemory).toHaveBeenCalledTimes(1);
			const [memory] = runtime.createMemory.mock.calls[0] as [Memory, string];
			expect((memory.content as Record<string, unknown>).platform).toBe(
				platform,
			);
			const metadata = memory.metadata as Record<string, unknown>;
			expect(metadata.platform).toBe(platform);
			expect(metadata.tags).toEqual(
				expect.arrayContaining([
					"link",
					"auto_capture",
					`platform:${platform}`,
				]),
			);
		},
	);

	it("defaults platform to 'unknown' when the message has no source", async () => {
		stubPreviewFetch(
			makeFetchResponse("<html><title>doc</title><body>x</body></html>"),
		);

		const runtime = makeRuntime(async () => "summary");
		const message = makeMessage("see https://example.com/no-source");
		const context = {
			...makeContext(runtime, message),
			state: { values: {}, data: {}, text: "" } as State,
		};
		await linkExtractionEvaluator.prepare?.(context);

		const [memory] = runtime.createMemory.mock.calls[0] as [Memory, string];
		expect((memory.content as Record<string, unknown>).platform).toBe(
			"unknown",
		);
		expect((memory.metadata as Record<string, unknown>).platform).toBe(
			"unknown",
		);
	});

	it("parse normalizes the LLM output into { processed }", () => {
		expect(linkExtractionEvaluator.parse?.({ processed: true })).toEqual({
			processed: true,
		});
		expect(linkExtractionEvaluator.parse?.({ processed: false })).toEqual({
			processed: false,
		});
		expect(linkExtractionEvaluator.parse?.("nope")).toEqual({
			processed: false,
		});
	});

	it("declares the expected name, priority, and schema", () => {
		expect(linkExtractionEvaluator.name).toBe("linkExtraction");
		expect(linkExtractionEvaluator.priority).toBe(70);
		const schema = linkExtractionEvaluator.schema as {
			type: string;
			properties: Record<string, unknown>;
			required: string[];
		};
		expect(schema.type).toBe("object");
		expect(schema.required).toEqual(["processed"]);
	});

	describe("linkExtractionEvaluator additional branches", () => {
		afterEach(() => {
			_setLinkPreviewTransportForTests(undefined);
			vi.restoreAllMocks();
		});

		function makePrepareContext(
			runtime: MockRuntime,
			message: Memory,
		): Parameters<NonNullable<typeof linkExtractionEvaluator.prepare>>[0] {
			return {
				...makeContext(runtime, message),
				state: { values: {}, data: {}, text: "" } as State,
			};
		}

		it("prompt renders the captured link count and the expected instruction", () => {
			const output = linkExtractionEvaluator.prompt?.({
				prepared: {
					links: [
						{ url: "https://a.example/1", title: "a", summary: "s" },
						{ url: "https://b.example/2", title: "", summary: "" },
					],
				},
			});
			expect(output).toContain("2 http(s) URL(s)");
			expect(output).toContain('Return {"processed":true}');
		});

		it("parse rejects arrays, null, and non-boolean processed values", () => {
			expect(linkExtractionEvaluator.parse?.(null)).toEqual({
				processed: false,
			});
			expect(linkExtractionEvaluator.parse?.(["processed"])).toEqual({
				processed: false,
			});
			expect(linkExtractionEvaluator.parse?.({ processed: "yes" })).toEqual({
				processed: false,
			});
			expect(linkExtractionEvaluator.parse?.({ processed: 1 })).toEqual({
				processed: false,
			});
			expect(
				linkExtractionEvaluator.parse?.({ processed: true, extra: 1 }),
			).toEqual({ processed: true });
		});

		it("shouldRun ignores non-http(s) schemes but accepts uppercase http(s)", async () => {
			const runtime = makeRuntime(async () => "");
			const ftpMessage = makeMessage(
				"grab ftp://files.example.com/a.txt or browse www.example.com",
			);
			await expect(
				linkExtractionEvaluator.shouldRun(makeContext(runtime, ftpMessage)),
			).resolves.toBe(false);

			const upperMessage = makeMessage("BIG ONE: HTTPS://EXAMPLE.COM/BIG");
			await expect(
				linkExtractionEvaluator.shouldRun(makeContext(runtime, upperMessage)),
			).resolves.toBe(true);
		});

		it("shouldRun is false when content.text is missing or not a string", async () => {
			const runtime = makeRuntime(async () => "");
			const numericText = {
				id: MESSAGE_ID,
				entityId: ENTITY_ID,
				agentId: AGENT_ID,
				roomId: ROOM_ID,
				content: { text: 42 },
				createdAt: Date.now(),
			} as Memory;
			await expect(
				linkExtractionEvaluator.shouldRun(makeContext(runtime, numericText)),
			).resolves.toBe(false);

			const noContent = {
				id: MESSAGE_ID,
				entityId: ENTITY_ID,
				agentId: AGENT_ID,
				roomId: ROOM_ID,
				createdAt: Date.now(),
			} as Memory;
			await expect(
				linkExtractionEvaluator.shouldRun(makeContext(runtime, noContent)),
			).resolves.toBe(false);
		});

		it.each([
			[
				"responds non-html",
				makeFetchResponse("<html><title>x</title></html>", {
					contentType: "application/json",
				}),
			],
			[
				"answers http 500",
				makeFetchResponse("<html><title>x</title></html>", { ok: false }),
			],
		])(
			"persists the raw URL without enrichment when the preview %s",
			async (_label, response) => {
				stubPreviewFetch(response);
				const runtime = makeRuntime(async () => "model must not run");
				const context = makePrepareContext(
					runtime,
					makeMessage("see https://rejected.example/page"),
				);

				const prepared = await linkExtractionEvaluator.prepare?.(context);

				expect(prepared?.links).toHaveLength(1);
				expect(prepared?.links[0]?.url).toBe("https://rejected.example/page");
				expect(prepared?.links[0]?.title).toBe("");
				expect(prepared?.links[0]?.summary).toBe("");
				expect(runtime.useModel).not.toHaveBeenCalled();
				expect(runtime.createMemory).toHaveBeenCalledTimes(1);
			},
		);

		it("skips summarization for an empty page body and persists the bare URL as content text", async () => {
			stubPreviewFetch(
				makeFetchResponse(
					"<html><head><title></title></head><body></body></html>",
				),
			);
			const runtime = makeRuntime(async () => "model must not run");
			const context = makePrepareContext(
				runtime,
				makeMessage("empty page https://blank.example/"),
			);

			const prepared = await linkExtractionEvaluator.prepare?.(context);

			expect(prepared?.links).toHaveLength(1);
			expect(prepared?.links[0]).toEqual({
				url: "https://blank.example/",
				title: "",
				summary: "",
			});
			expect(runtime.useModel).not.toHaveBeenCalled();
			expect(runtime.createMemory).toHaveBeenCalledTimes(1);
			const [memory] = runtime.createMemory.mock.calls[0] as [Memory, string];
			expect(memory.content.text).toBe("https://blank.example/");
			const metadata = memory.metadata as Record<string, unknown>;
			expect(metadata.title).toBe("");
			expect(metadata.summary).toBe("");
		});

		it("keeps extracting later URLs when one URL fails to persist", async () => {
			stubPreviewFetch(
				makeFetchResponse("<html><title>doc</title><body>x</body></html>"),
			);
			const runtime = {
				...makeRuntime(async () => "sum"),
				reportError: vi.fn(),
			};
			runtime.createMemory.mockRejectedValueOnce(new Error("db down"));
			const context = makePrepareContext(
				runtime,
				makeMessage(
					"one https://ok.example/first and two https://ok.example/second",
				),
			);

			const prepared = await linkExtractionEvaluator.prepare?.(context);

			expect(prepared?.links.map((link) => link.url)).toEqual([
				"https://ok.example/first",
				"https://ok.example/second",
			]);
			expect(runtime.createMemory).toHaveBeenCalledTimes(2);
			const [, secondCall] = runtime.createMemory.mock.calls as [
				Memory,
				string,
			][];
			expect(secondCall?.[0].content.url).toBe("https://ok.example/second");
			expect(runtime.logger.warn).toHaveBeenCalledTimes(1);
			expect(runtime.logger.warn).toHaveBeenCalledWith(
				expect.objectContaining({
					src: "evaluator:link-extraction",
					url: "https://ok.example/first",
					err: "db down",
				}),
				"Link extraction failed",
			);
			expect(runtime.reportError).toHaveBeenCalledTimes(1);
			expect(runtime.reportError).toHaveBeenCalledWith(
				"LinkExtraction.extract",
				expect.any(Error),
				{ url: "https://ok.example/first" },
			);
		});

		it("persists one memory per distinct URL in first-seen order", async () => {
			stubPreviewFetch(
				makeFetchResponse("<html><title>doc</title><body>x</body></html>"),
			);
			const runtime = makeRuntime(async () => "sum");
			const context = makePrepareContext(
				runtime,
				makeMessage(
					"first https://multi.example/1 then https://multi.example/2",
				),
			);

			const prepared = await linkExtractionEvaluator.prepare?.(context);

			expect(prepared?.links.map((link) => link.url)).toEqual([
				"https://multi.example/1",
				"https://multi.example/2",
			]);
			expect(runtime.createMemory).toHaveBeenCalledTimes(2);
			const calls = runtime.createMemory.mock.calls as [Memory, string][];
			expect(calls[0]?.[0].content.url).toBe("https://multi.example/1");
			expect(calls[1]?.[0].content.url).toBe("https://multi.example/2");
			calls.forEach(([memory, tableName]) => {
				expect(tableName).toBe("links");
				expect(memory.content.type).toBe("link");
			});
		});
	});
});
