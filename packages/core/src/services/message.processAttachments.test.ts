import { beforeEach, describe, expect, it, vi } from "vitest";
import { ContentType, type Media } from "../types/primitives";
import type { IAgentRuntime } from "../types/runtime";

// Network-free: the SSRF-guarded remote fetcher is mocked so the lane performs
// ZERO real outbound requests. importActual preserves the module's other exports
// (the runtime graph imports more than fetchRemoteMedia from here).
const fetchRemoteMedia = vi.fn();
vi.mock("../media/fetch", async (importActual) => ({
	...(await importActual<typeof import("../media/fetch")>()),
	fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMedia(...args),
}));

const { DefaultMessageService } = await import("./message");

function mockRuntime(
	fetchImpl?: (input: unknown) => Promise<unknown>,
): IAgentRuntime {
	return {
		logger: {
			debug: vi.fn(),
			warn: vi.fn(),
			info: vi.fn(),
			error: vi.fn(),
		},
		getSetting: vi.fn(() => undefined),
		useModel: vi.fn(),
		fetch: fetchImpl,
	} as unknown as IAgentRuntime;
}

describe("DefaultMessageService.processAttachments", () => {
	beforeEach(() => {
		fetchRemoteMedia.mockReset();
	});

	it("returns [] for no attachments", async () => {
		const svc = new DefaultMessageService();
		expect(await svc.processAttachments(mockRuntime(), [])).toEqual([]);
	});

	it("isolates a failing attachment, keeping the others, and never throws", async () => {
		// Remote image enrichment fails (e.g. SSRF-blocked / unreachable host).
		fetchRemoteMedia.mockRejectedValue(new Error("SSRF blocked"));
		const svc = new DefaultMessageService();
		const runtime = mockRuntime();

		const badImage: Media = {
			id: "a",
			url: "http://169.254.169.254/secret.png",
			contentType: ContentType.IMAGE,
		};
		// A doc that already has text skips the fetch entirely → passes through.
		const okDoc: Media = {
			id: "b",
			url: "http://example.com/readme.txt",
			contentType: ContentType.DOCUMENT,
			text: "already extracted",
		};

		const out = await svc.processAttachments(runtime, [badImage, okDoc]);

		expect(out).toHaveLength(2);
		// Failed remote attachment: un-enriched, flagged ephemeral, URL preserved.
		expect(out[0].description).toBeUndefined();
		expect(out[0].ephemeral).toBe(true);
		expect(out[0].url).toBe(badImage.url);
		// Untouched sibling still carries its text.
		expect(out[1].text).toBe("already extracted");
		// The vision model was never invoked for the blocked URL.
		expect(runtime.useModel).not.toHaveBeenCalled();
	});

	it("routes a remote attachment fetch through the SSRF-guarded fetcher", async () => {
		fetchRemoteMedia.mockRejectedValue(new Error("blocked"));
		const svc = new DefaultMessageService();
		const runtime = mockRuntime();
		await svc.processAttachments(runtime, [
			{
				id: "a",
				url: "http://10.0.0.5/internal.pdf",
				contentType: ContentType.DOCUMENT,
			},
		]);
		expect(fetchRemoteMedia).toHaveBeenCalledTimes(1);
		expect(fetchRemoteMedia.mock.calls[0][0]).toMatchObject({
			url: "http://10.0.0.5/internal.pdf",
		});
	});

	it("extracts text from a local plain-text document via the trusted local fetch", async () => {
		const bytes = Buffer.from("hello from a local file", "utf8");
		const localFetch = vi.fn(async () => ({
			ok: true,
			arrayBuffer: async () =>
				bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
			headers: { get: () => "text/plain; charset=utf-8" },
		}));
		const svc = new DefaultMessageService();
		const runtime = mockRuntime(localFetch as unknown as typeof fetch);

		const out = await svc.processAttachments(runtime, [
			{
				id: "doc",
				url: "/api/media/abc.txt",
				contentType: ContentType.DOCUMENT,
			},
		]);

		expect(out[0].text).toBe("hello from a local file");
		// Local URL → trusted runtime fetch, NOT the SSRF remote fetcher.
		expect(fetchRemoteMedia).not.toHaveBeenCalled();
		expect(localFetch).toHaveBeenCalledTimes(1);
	});
});
