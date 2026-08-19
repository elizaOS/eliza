/**
 * Exercises attachment body limits through the real basic-capabilities document
 * path, including declared oversize rejection before reading and cancellation of
 * a chunked response as soon as its running byte total crosses the cap.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaFetchError } from "../../media/index.ts";
import {
	ContentType,
	type IAgentRuntime,
	type Media,
	type UUID,
} from "../../types/index.ts";
import { processAttachments } from "./index.ts";

const agentId = "00000000-0000-0000-0000-0000000000ab" as UUID;
const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

function makeRuntime(): IAgentRuntime {
	return {
		agentId,
		logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
	} as unknown as IAgentRuntime;
}

function textDocument(url: string): Media {
	return { id: url, url, contentType: ContentType.DOCUMENT } as Media;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("basic-capabilities attachment body limits", () => {
	it("rejects an oversized Content-Length without reading the body", async () => {
		let readerRequests = 0;
		const response = {
			ok: true,
			statusText: "OK",
			headers: new Headers({
				"content-length": String(MAX_MEDIA_BYTES + 1),
				"content-type": "text/plain",
			}),
			body: {
				getReader() {
					readerRequests += 1;
					throw new Error("body must not be read");
				},
			},
		} as unknown as Response;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => response),
		);

		const error = await processAttachments(
			[textDocument("https://media.test/declared-too-large.txt")],
			makeRuntime(),
		).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(MediaFetchError);
		expect(error).toMatchObject({ code: "max_bytes" });
		expect((error as Error).message).toMatch(/exceeds size limit/);
		expect(readerRequests).toBe(0);
	});

	it("cancels a chunked body when the running byte total exceeds the cap", async () => {
		let reads = 0;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					reads += 1;
					if (reads === 1) {
						controller.enqueue(new Uint8Array(MAX_MEDIA_BYTES));
					} else if (reads === 2) {
						controller.enqueue(new Uint8Array([1]));
					} else {
						controller.close();
					}
				},
				cancel() {
					cancelled = true;
				},
			},
			{ highWaterMark: 0 },
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(body, { headers: { "content-type": "text/plain" } }),
			),
		);

		const error = await processAttachments(
			[textDocument("https://media.test/chunked-too-large.txt")],
			makeRuntime(),
		).catch((cause: unknown) => cause);
		expect(error).toBeInstanceOf(MediaFetchError);
		expect(error).toMatchObject({ code: "max_bytes" });
		expect((error as Error).message).toMatch(/maxBytes/);
		expect(reads).toBeLessThanOrEqual(3);
		expect(cancelled).toBe(true);
	});
});
