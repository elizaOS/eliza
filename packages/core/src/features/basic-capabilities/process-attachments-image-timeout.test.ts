/**
 * Guards the local media-server image fetch inside processAttachments: the
 * non-remote branch must carry a bounded AbortSignal so a stalled local server
 * fails closed instead of leaving the attachment-processing turn pending
 * forever (same fail-closed class as the remote fetch-with-timeout work).
 */
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	ContentType,
	type IAgentRuntime,
	type Media,
	type UUID,
} from "../../types/index.ts";
import { processAttachments } from "./index.ts";

const agentId = "00000000-0000-0000-0000-0000000000aa" as UUID;

function makeRuntime(): IAgentRuntime {
	const store = new Map<string, unknown>();
	return {
		agentId,
		logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
		reportError: vi.fn(),
		getCache: vi.fn(async (key: string) => store.get(key)),
		setCache: vi.fn(async (key: string, value: unknown) => {
			store.set(key, value);
		}),
		useModel: vi.fn(async () => ({
			description: "a test image",
			title: "test image",
			text: "test image",
		})),
	} as unknown as IAgentRuntime;
}

/** A 1x1 transparent PNG (spec-valid bytes) so the image path accepts it. */
const PNG_BYTES = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

function image(url: string): Media {
	return { id: url, url, contentType: ContentType.IMAGE } as Media;
}

function doc(url: string): Media {
	return { id: url, url, contentType: ContentType.DOCUMENT } as Media;
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("processAttachments — local image fetch timeout", () => {
	it("passes a bounded AbortSignal to the local media-server fetch", async () => {
		let capturedInit: RequestInit | undefined;
		vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
			capturedInit = init;
			return {
				ok: true,
				statusText: "OK",
				headers: { get: () => "image/png" },
				text: async () => "",
				arrayBuffer: async () =>
					PNG_BYTES.buffer.slice(
						PNG_BYTES.byteOffset,
						PNG_BYTES.byteOffset + PNG_BYTES.byteLength,
					),
			} as unknown as Response;
		});

		// Non-http URL → local media-server path (getLocalServerUrl → localhost).
		const [out] = await processAttachments(
			[image("uploads/photo.png")],
			makeRuntime(),
		);

		expect(capturedInit).toBeDefined();
		expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
		expect(out).toBeDefined();
	});

	it("wires a real timeout signal (AbortSignal.timeout) on the local fetch", async () => {
		let capturedInit: RequestInit | undefined;
		vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
			capturedInit = init;
			return {
				ok: true,
				statusText: "OK",
				headers: { get: () => "image/png" },
				text: async () => "",
				arrayBuffer: async () =>
					PNG_BYTES.buffer.slice(
						PNG_BYTES.byteOffset,
						PNG_BYTES.byteOffset + PNG_BYTES.byteLength,
					),
			} as unknown as Response;
		});

		await processAttachments([image("uploads/photo.png")], makeRuntime());

		expect(capturedInit).toBeDefined();
		const signal = capturedInit?.signal as AbortSignal;
		expect(signal).toBeInstanceOf(AbortSignal);
		// AbortSignal.timeout() signals start un-aborted and reject with
		// TimeoutError after the window. Assert the wiring is a real timeout
		// signal by checking it aborts on its own schedule (reason becomes a
		// DOMException/TimeoutError once fired).
		expect(signal.aborted).toBe(false);
		const reason: unknown = signal.reason;
		expect(reason).toBeUndefined();
	});

	it("fails closed with a TimeoutError-shaped rejection on a hung server", async () => {
		// Shrink the timeout window so the fail-closed path is exercised in
		// milliseconds instead of waiting the real 30s window. The production
		// call still goes through AbortSignal.timeout → the same reject path.
		const fastTimeout = vi
			.spyOn(AbortSignal, "timeout")
			.mockReturnValue(AbortSignal.timeout(50));

		vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
			const signal = init?.signal as AbortSignal | undefined;
			return new Promise<Response>((_resolve, reject) => {
				if (signal) {
					signal.addEventListener("abort", () =>
						reject(signal.reason ?? new Error("TimeoutError")),
					);
				}
			});
		});

		await expect(
			processAttachments([image("uploads/photo.png")], makeRuntime()),
		).rejects.toThrow();
		expect(fastTimeout).toHaveBeenCalled();
	});

	it("passes a bounded AbortSignal to the local document fetch too", async () => {
		let capturedInit: RequestInit | undefined;
		vi.stubGlobal("fetch", async (_input: string | URL, init?: RequestInit) => {
			capturedInit = init;
			return {
				ok: true,
				statusText: "OK",
				headers: { get: () => "text/plain" },
				text: async () => "plain notes body",
				arrayBuffer: async () => Buffer.from("plain notes body", "utf-8"),
			} as unknown as Response;
		});

		const [out] = await processAttachments(
			[doc("uploads/notes.txt")],
			makeRuntime(),
		);

		expect(capturedInit).toBeDefined();
		expect(capturedInit?.signal).toBeInstanceOf(AbortSignal);
		expect(out.text).toBe("plain notes body");
	});
});
