/**
 * Behavioral suite for the Node pinned transport behind the SSRF fetch guard:
 * `nodePinnedFetch` request construction and Web-Headers normalization, body
 * buffering across every BodyInit shape, IncomingMessage → web Response
 * conversion (streamed and null bodies), abort-signal wiring, once-only error
 * settlement, and the `nodeLookupFn` resolver mapping contract. Deterministic —
 * node:http, node:https and node:dns/promises are replaced at their module
 * boundary; no sockets are opened, no DNS is resolved, no timers are used.
 */
import { Buffer } from "node:buffer";
import { lookup as dnsLookup } from "node:dns/promises";
import { EventEmitter } from "node:events";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nodeLookupFn, nodePinnedFetch } from "./node-pinned-fetch.ts";
import type { LookupFn } from "./ssrf.ts";

vi.mock("node:http", () => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: vi.fn() }));

type CapturedOptions = {
	protocol: string;
	hostname: string;
	port?: number;
	method: string;
	path: string;
	headers: Record<string, string>;
	lookup?: unknown;
	servername?: string;
};

type Deliver = (message: FakeIncomingMessage) => void;

type RequestSpy = {
	mock: {
		calls: Array<[CapturedOptions, Deliver]>;
		results: Array<{ value: FakeClientRequest }>;
	};
	mockImplementation(
		impl: (options: CapturedOptions, callback: Deliver) => FakeClientRequest,
	): void;
};

type DnsSpy = {
	mock: { calls: Array<[string, { all: true }]> };
	mockResolvedValue(entries: Array<{ address: string; family: number }>): void;
	mockRejectedValue(error: Error): void;
};

const httpSpy = httpRequest as unknown as RequestSpy;
const httpsSpy = httpsRequest as unknown as RequestSpy;
const dnsSpy = dnsLookup as unknown as DnsSpy;

const pinnedLookup: LookupFn = async () => [];

class FakeClientRequest extends EventEmitter {
	readonly options: CapturedOptions;
	readonly writes: Buffer[] = [];
	endCalls = 0;
	destroyCalls: Array<Error | undefined> = [];

	constructor(options: CapturedOptions) {
		super();
		this.options = options;
	}

	write(chunk: Buffer): boolean {
		this.writes.push(Buffer.from(chunk));
		return true;
	}

	end(): this {
		this.endCalls += 1;
		return this;
	}

	destroy(error?: Error): this {
		this.destroyCalls.push(error);
		if (error) {
			queueMicrotask(() => this.emit("error", error));
		}
		return this;
	}
}

class FakeIncomingMessage {
	headers: Record<string, string | string[] | undefined>;
	statusCode?: number;
	statusMessage?: string;
	chunks: Array<Buffer | Uint8Array | string> = [];
	iteratorError?: Error;
	destroyReasons: Array<Error | undefined> = [];
	returnCalled = false;

	constructor(
		parts: {
			headers?: Record<string, string | string[] | undefined>;
			statusCode?: number;
			statusMessage?: string;
		} = {},
	) {
		this.headers = parts.headers ?? {};
		this.statusCode = parts.statusCode;
		this.statusMessage = parts.statusMessage;
	}

	destroy(reason?: Error): this {
		this.destroyReasons.push(reason);
		return this;
	}

	[Symbol.asyncIterator](): AsyncIterator<Buffer | Uint8Array | string> {
		let index = 0;
		const message = this;
		return {
			async next() {
				if (index < message.chunks.length) {
					const value = message.chunks[index];
					index += 1;
					return { done: false as const, value };
				}
				if (message.iteratorError) {
					throw message.iteratorError;
				}
				return { done: true as const, value: undefined };
			},
			async return(value?: undefined) {
				message.returnCalled = true;
				return { done: true as const, value };
			},
		};
	}
}

type FetchInit = {
	method?: string;
	headers?: HeadersInit;
	body?: BodyInit | null;
	signal?: AbortSignal | null;
};

function settleMicrotasks(): Promise<void> {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}

async function beginFetch(
	init: FetchInit,
	url = new URL("http://example.test/path"),
): Promise<{
	options: CapturedOptions;
	deliver: Deliver;
	request: FakeClientRequest;
	pending: Promise<Response>;
}> {
	const spy = url.protocol === "https:" ? httpsSpy : httpSpy;
	spy.mockImplementation((options) => new FakeClientRequest(options));
	const pending = nodePinnedFetch({ url, init, lookup: pinnedLookup });
	pending.catch(() => {});
	await settleMicrotasks();
	await settleMicrotasks();
	const call = spy.mock.calls.at(-1);
	if (!call) throw new Error("transport was never invoked");
	const result = spy.mock.results.at(-1);
	if (!result) throw new Error("transport returned no request handle");
	return {
		options: call[0],
		deliver: call[1],
		request: result.value,
		pending,
	};
}

function okMessage(): FakeIncomingMessage {
	return new FakeIncomingMessage({
		statusCode: 200,
		statusMessage: "OK",
	});
}

async function flushed<T>(promise: Promise<T>): Promise<T> {
	await Promise.resolve();
	await Promise.resolve();
	return promise;
}

beforeEach(() => {
	vi.resetAllMocks();
});

describe("nodeLookupFn", () => {
	it("passes hostname and options through unchanged and maps entries to { address, family }", async () => {
		dnsSpy.mockResolvedValue([
			{ address: "93.184.216.34", family: 4 },
			{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
		]);

		const results = await nodeLookupFn("example.test", { all: true });

		expect(dnsSpy.mock.calls).toStrictEqual([["example.test", { all: true }]]);
		expect(results).toStrictEqual([
			{ address: "93.184.216.34", family: 4 },
			{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
		]);
	});

	it("maps an empty resolver result to an empty array", async () => {
		dnsSpy.mockResolvedValue([]);

		await expect(
			nodeLookupFn("empty.test", { all: true }),
		).resolves.toStrictEqual([]);
	});

	it("propagates resolver rejection without conversion or fallback", async () => {
		const failure = new Error("resolver down");
		dnsSpy.mockRejectedValue(failure);

		await expect(nodeLookupFn("broken.test", { all: true })).rejects.toBe(
			failure,
		);
	});
});

describe("nodePinnedFetch request construction", () => {
	it("builds an http request from the URL, init and pinned lookup", async () => {
		const interaction = await beginFetch(
			{
				method: "post",
				headers: { "x-token": "t" },
				body: "payload",
			},
			new URL("http://example.test:8080/db/search?q=eliza"),
		);

		expect(interaction.options).toStrictEqual({
			protocol: "http:",
			hostname: "example.test",
			port: 8080,
			method: "POST",
			path: "/db/search?q=eliza",
			headers: { "x-token": "t", "content-length": "7" },
			lookup: pinnedLookup,
		});
		expect("servername" in interaction.options).toBe(false);
		expect(interaction.request.writes).toStrictEqual([Buffer.from("payload")]);
		expect(interaction.request.endCalls).toBe(1);
		expect(httpsSpy.mock.calls).toHaveLength(0);

		interaction.deliver(okMessage());
		const response = await interaction.pending;
		expect(response.status).toBe(200);
	});

	it("selects node:https for https URLs and pins servername to the hostname", async () => {
		const interaction = await beginFetch(
			{},
			new URL("https://example.test/secure"),
		);

		expect(httpsSpy.mock.calls).toHaveLength(1);
		expect(httpSpy.mock.calls).toHaveLength(0);
		expect(interaction.options.protocol).toBe("https:");
		expect(interaction.options.servername).toBe("example.test");

		interaction.deliver(okMessage());
		const response = await interaction.pending;
		expect(response.status).toBe(200);
	});

	it("defaults to GET, no numeric port and root path when the URL carries none", async () => {
		const interaction = await beginFetch({}, new URL("http://defaults.test"));

		expect(interaction.options.method).toBe("GET");
		expect(interaction.options.port).toBeUndefined();
		expect(interaction.options.path).toBe("/");

		interaction.deliver(okMessage());
		await interaction.pending;
	});

	it("normalizes input headers with Web Headers semantics", async () => {
		const headers = new Headers();
		headers.append("Set-Cookie", "a=1");
		headers.append("set-cookie", "b=2");
		headers.set("X-Case", "Up");

		const interaction = await beginFetch({ headers });

		expect(interaction.options.headers).toStrictEqual({
			"set-cookie": "b=2",
			"x-case": "Up",
		});

		interaction.deliver(okMessage());
		await interaction.pending;
	});
});

describe("nodePinnedFetch request bodies", () => {
	async function bodyCase(init: FetchInit): Promise<{
		options: CapturedOptions;
		request: FakeClientRequest;
	}> {
		const interaction = await beginFetch(init);
		interaction.deliver(okMessage());
		const response = await interaction.pending;
		await response.text();
		return { options: interaction.options, request: interaction.request };
	}

	it("sends no bytes and synthesizes no content-length for an undefined body", async () => {
		const { options, request } = await bodyCase({ method: "POST" });

		expect(request.writes).toStrictEqual([]);
		expect(options.headers["content-length"]).toBeUndefined();
		expect(request.endCalls).toBe(1);
	});

	it("sends no bytes and synthesizes no content-length for a null body", async () => {
		const { options, request } = await bodyCase({
			method: "POST",
			body: null,
		});

		expect(request.writes).toStrictEqual([]);
		expect(options.headers["content-length"]).toBeUndefined();
		expect(request.endCalls).toBe(1);
	});

	it("writes a zero-length buffer and content-length 0 for an empty string body", async () => {
		const { options, request } = await bodyCase({
			method: "PUT",
			body: "",
		});

		expect(request.writes).toStrictEqual([Buffer.from("")]);
		expect(options.headers["content-length"]).toBe("0");
		expect(request.endCalls).toBe(1);
	});

	it("encodes string bodies as UTF-8 bytes with the byte-length header", async () => {
		const text = "héllo ✅";
		const { options, request } = await bodyCase({ body: text });

		expect(request.writes).toStrictEqual([Buffer.from(text)]);
		expect(options.headers["content-length"]).toBe(
			String(Buffer.byteLength(text)),
		);
	});

	it("copies ArrayBuffer bodies exactly", async () => {
		const arrayBuffer = Uint8Array.from([1, 2, 3, 4]).buffer;
		const { options, request } = await bodyCase({ body: arrayBuffer });

		expect(request.writes).toStrictEqual([Buffer.from([1, 2, 3, 4])]);
		expect(options.headers["content-length"]).toBe("4");
	});

	it("buffers only the byteOffset..byteLength window of a typed-array view", async () => {
		const backing = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
		const { options, request } = await bodyCase({
			body: backing.subarray(2, 5),
		});

		expect(request.writes).toStrictEqual([Buffer.from([3, 4, 5])]);
		expect(options.headers["content-length"]).toBe("3");
	});

	it("buffers only the DataView window over its backing buffer", async () => {
		const backing = Uint8Array.from([9, 8, 7, 6, 5]);
		const { request } = await bodyCase({
			body: new DataView(backing.buffer, 1, 3),
		});

		expect(request.writes).toStrictEqual([Buffer.from([8, 7, 6])]);
	});

	it("serializes fallback bodies through Response(arrayBuffer), such as Blob", async () => {
		const { options, request } = await bodyCase({
			method: "POST",
			body: new Blob(["hi"]),
		});

		expect(request.writes).toStrictEqual([Buffer.from("hi")]);
		expect(options.headers["content-length"]).toBe("2");
		expect(request.endCalls).toBe(1);
	});

	it.each(["0", "999"])(
		"preserves an existing content-length of %s instead of recomputing it",
		async (existing) => {
			const { options, request } = await bodyCase({
				method: "POST",
				headers: { "content-length": existing },
				body: "abc",
			});

			expect(options.headers["content-length"]).toBe(existing);
			expect(request.writes).toStrictEqual([Buffer.from("abc")]);
			expect(request.endCalls).toBe(1);
		},
	);
});

describe("nodePinnedFetch response conversion", () => {
	async function beginResponse(message: FakeIncomingMessage) {
		const interaction = await beginFetch({});
		interaction.deliver(message);
		return interaction;
	}

	it("converts status, statusText and header shapes into the web Response", async () => {
		const interaction = await beginResponse(
			new FakeIncomingMessage({
				statusCode: 201,
				statusMessage: "Created",
				headers: {
					"content-type": "text/plain",
					"set-cookie": ["a=1", "b=2"],
					"x-num": undefined,
				},
			}),
		);

		const response = await interaction.pending;
		expect(response.status).toBe(201);
		expect(response.statusText).toBe("Created");
		expect(response.headers.get("content-type")).toBe("text/plain");
		expect(response.headers.getSetCookie()).toStrictEqual(["a=1", "b=2"]);
		expect(response.headers.get("x-num")).toBeNull();
	});

	it("falls back to status 500 when statusCode is missing", async () => {
		const interaction = await beginResponse(new FakeIncomingMessage());

		const response = await interaction.pending;
		expect(response.status).toBe(500);
	});

	it("streams Buffer, Uint8Array and string chunks as concatenated body bytes", async () => {
		const message = new FakeIncomingMessage({
			statusCode: 200,
			statusMessage: "OK",
		});
		message.chunks = [Buffer.from("he"), new TextEncoder().encode("ll"), "o!"];
		const interaction = await beginResponse(message);

		const response = await interaction.pending;
		await expect(response.text()).resolves.toBe("hello!");
	});

	it("removes the abort listener once the streamed body completes", async () => {
		const controller = new AbortController();
		const interaction = await beginFetch({ signal: controller.signal });
		const message = okMessage();
		message.chunks = ["done"];
		interaction.deliver(message);

		const response = await interaction.pending;
		await response.text();

		controller.abort();
		await flushed(Promise.resolve());
		expect(interaction.request.destroyCalls).toHaveLength(0);
	});

	it.each([204, 205, 304])(
		"gives %s responses a null body and cleans up without consuming the stream",
		async (status) => {
			const controller = new AbortController();
			const interaction = await beginFetch({ signal: controller.signal });
			const message = new FakeIncomingMessage({
				statusCode: status,
				statusMessage: "Null body",
			});
			message.chunks = ["never consumed"];
			interaction.deliver(message);

			const response = await interaction.pending;
			expect(response.status).toBe(status);
			expect(response.body).toBeNull();

			controller.abort();
			await flushed(Promise.resolve());
			expect(interaction.request.destroyCalls).toHaveLength(0);
		},
	);

	it("surfaces iterator failures through the body and cleans up", async () => {
		const controller = new AbortController();
		const interaction = await beginFetch({ signal: controller.signal });
		const message = okMessage();
		const failure = new Error("stream exploded");
		message.chunks = ["partial"];
		message.iteratorError = failure;
		interaction.deliver(message);

		const response = await interaction.pending;
		await expect(response.text()).rejects.toBe(failure);

		controller.abort();
		await flushed(Promise.resolve());
		expect(interaction.request.destroyCalls).toHaveLength(0);
	});

	it("destroys the Node stream with the Error reason when the body is cancelled", async () => {
		const message = okMessage();
		message.chunks = ["chunk-1", "chunk-2"];
		const interaction = await beginResponse(message);

		const response = await interaction.pending;
		const reader = response.body?.getReader();
		const first = await reader?.read();
		expect(first?.done).toBe(false);

		const reason = new Error("consumer cancelled");
		await reader?.cancel(reason);
		await flushed(Promise.resolve());

		expect(message.returnCalled).toBe(true);
		expect(message.destroyReasons).toStrictEqual([reason]);
	});

	it("destroys the Node stream without a reason for non-Error cancellation", async () => {
		const message = okMessage();
		message.chunks = ["chunk-1"];
		const interaction = await beginResponse(message);

		const response = await interaction.pending;
		const reader = response.body?.getReader();
		await reader?.read();

		await reader?.cancel("just stop");
		await flushed(Promise.resolve());

		expect(message.returnCalled).toBe(true);
		expect(message.destroyReasons).toStrictEqual([undefined]);
	});
});

describe("nodePinnedFetch failures and aborts", () => {
	it("rejects with the request error and detaches the abort listener", async () => {
		const controller = new AbortController();
		const interaction = await beginFetch({ signal: controller.signal });

		const failure = new Error("connect ECONNREFUSED");
		interaction.request.emit("error", failure);

		await expect(interaction.pending).rejects.toBe(failure);

		controller.abort();
		await flushed(Promise.resolve());
		expect(interaction.request.destroyCalls).toHaveLength(0);
	});

	it("settles exactly once when the request emits multiple errors", async () => {
		const interaction = await beginFetch({});

		const first = new Error("first failure");
		interaction.request.emit("error", first);
		interaction.request.emit("error", new Error("second failure"));

		await expect(interaction.pending).rejects.toBe(first);
	});

	it("keeps the settled response valid when a late request error arrives", async () => {
		const interaction = await beginFetch({});
		const message = okMessage();
		message.chunks = ["still good"];
		interaction.deliver(message);

		const response = await interaction.pending;
		interaction.request.emit("error", new Error("late failure"));

		expect(response.status).toBe(200);
		await expect(response.text()).resolves.toBe("still good");
	});

	it("destroys an already-aborted request before sending", async () => {
		const controller = new AbortController();
		controller.abort();
		const interaction = await beginFetch({ signal: controller.signal });

		expect(interaction.request.destroyCalls).toHaveLength(1);
		const abortError = interaction.request.destroyCalls[0];
		expect(abortError).toBeInstanceOf(DOMException);
		expect(abortError?.name).toBe("AbortError");

		await expect(interaction.pending).rejects.toBe(abortError);
		expect(interaction.request.endCalls).toBe(1);
	});

	it("destroys the request when aborted between send and response", async () => {
		const controller = new AbortController();
		const interaction = await beginFetch({ signal: controller.signal });

		controller.abort();
		expect(interaction.request.destroyCalls).toHaveLength(1);
		const abortError = interaction.request.destroyCalls[0];
		expect(abortError?.name).toBe("AbortError");

		await expect(interaction.pending).rejects.toBe(abortError);
	});
});
