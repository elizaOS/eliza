/**
 * Deterministic coverage for conversation attachment gathering: access-scoped
 * message rows must be filtered before the ATTACHMENT action can read stored
 * text or original URLs. The harness stubs runtime memory/world access; no live
 * model or database is involved.
 */
import { describe, expect, it, vi } from "vitest";
import { fetchRemoteMedia } from "../../media/fetch.ts";
import { getLocalServerUrl } from "../../utils/node.ts";

vi.mock("../../media/fetch.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../media/fetch.ts")>();
	return { ...actual, fetchRemoteMedia: vi.fn(actual.fetchRemoteMedia) };
});

import type { IAgentRuntime, Memory, UUID } from "../../types/index.ts";
import {
	listConversationAttachments,
	readAttachmentRecords,
} from "./attachmentContext.ts";

const agentId = "00000000-0000-0000-0000-0000000000a9" as UUID;
const userId = "00000000-0000-0000-0000-000000000002" as UUID;
const ownerId = "00000000-0000-0000-0000-000000000003" as UUID;
const roomId = "00000000-0000-0000-0000-000000000004" as UUID;

function makeRuntime(recentMessages: Memory[]): IAgentRuntime {
	return {
		agentId,
		getConversationLength: () => 20,
		getMemories: async () => recentMessages,
		getRoom: async () => null,
		logger: { warn: () => undefined },
	} as unknown as IAgentRuntime;
}

function viewerMessage(text = "read the attachment"): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000005" as UUID,
		entityId: userId,
		roomId,
		content: { text },
		createdAt: 2,
	} as Memory;
}

function privateAttachmentMemory(granted = false): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000006" as UUID,
		entityId: ownerId,
		roomId,
		createdAt: 1,
		metadata: {
			scope: "owner-private",
			share: granted
				? {
						grants: [
							{
								entityId: userId,
								mode: "redacted",
							},
						],
					}
				: undefined,
		},
		content: {
			text: "private attachment",
			attachments: [
				{
					id: "private-image",
					url: "https://example.test/original.jpg",
					redactedUrl: "https://example.test/redacted.jpg",
					thumbnailUrl: "https://example.test/thumb.jpg",
					title: "Private Image",
					source: "Image",
					contentType: "document",
					text: "full extracted text",
					description: "full description",
				},
			],
		},
	} as Memory;
}

describe("attachmentContext disclosure", () => {
	it("omits owner-private attachments for an ungranted requester", async () => {
		const attachments = await listConversationAttachments(
			makeRuntime([privateAttachmentMemory(false)]),
			viewerMessage(),
		);

		expect(attachments).toEqual([]);
	});

	it("downgrades a redacted grant before ATTACHMENT action content reads", async () => {
		const records = await readAttachmentRecords(
			makeRuntime([privateAttachmentMemory(true)]),
			viewerMessage("read private-image"),
			"private-image",
		);

		expect(records).toHaveLength(1);
		expect(records[0]?.attachment.url).toBe(
			"https://example.test/redacted.jpg",
		);
		expect(records[0]?.attachment.redacted).toBe(true);
		expect(records[0]?.attachment.thumbnailUrl).toBeUndefined();
		expect(records[0]?.attachment.text).toBeUndefined();
		expect(records[0]?.content).toBe("");
	});
});

function neonCatMessage(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000008" as UUID,
		entityId: agentId,
		roomId,
		createdAt: 1,
		content: {
			text: "here's your image",
			attachments: [
				{
					id: "neon-cat",
					url: "https://example.test/cat.png",
					title: "Neon Cat",
					source: "media-generation",
					contentType: "image",
					text: "a neon cat sitting on a synthwave grid.",
				},
			],
		},
	} as Memory;
}

function currentImageQuestion(): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000009" as UUID,
		entityId: userId,
		roomId,
		createdAt: 2,
		content: {
			text: "what's in this image? describe it",
			attachments: [
				{
					id: "eliza-pic",
					url: "https://example.test/eliza.png",
					title: "Eliza",
					source: "Image",
					contentType: "image",
					text: "an eliza profile picture",
				},
			],
		},
	} as Memory;
}

describe("current-message attachment wins over a stale explicit id", () => {
	it("reads the freshly-attached image, not a prior attachment's cached text", async () => {
		// BUG 1: the planner named the PRIOR generated image's id (the cheapest
		// readable candidate — it already carried cached .text). The current
		// message carries its OWN freshly-attached image, so that attachment must
		// win over the stale id resolved against room history.
		const records = await readAttachmentRecords(
			makeRuntime([neonCatMessage()]),
			currentImageQuestion(),
			"neon-cat",
		);

		expect(records).toHaveLength(1);
		expect(records[0]?.attachment.id).toBe("eliza-pic");
		expect(records[0]?.content).toBe("an eliza profile picture");
		expect(records[0]?.autoSelected).toBe(true);
	});

	it("still honors a genuine recent read when the current message carries no attachment", async () => {
		const records = await readAttachmentRecords(
			makeRuntime([neonCatMessage()]),
			viewerMessage(),
			"neon-cat",
		);

		expect(records).toHaveLength(1);
		expect(records[0]?.attachment.id).toBe("neon-cat");
		expect(records[0]?.autoSelected).toBe(false);
	});

	it("honors an explicit id that names one of the current-message attachments", async () => {
		const records = await readAttachmentRecords(
			makeRuntime([neonCatMessage()]),
			currentImageQuestion(),
			"eliza-pic",
		);

		expect(records).toHaveLength(1);
		expect(records[0]?.attachment.id).toBe("eliza-pic");
		expect(records[0]?.autoSelected).toBe(false);
	});
});

describe("image attachments without stored text inline bytes before describing (#18760)", () => {
	const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

	function imageMessage(url: string): Memory {
		return {
			id: "00000000-0000-0000-0000-000000000010" as UUID,
			entityId: userId,
			roomId,
			createdAt: 2,
			content: {
				text: "what's in this image?",
				attachments: [
					{ id: "img-1", url, title: "Image", contentType: "image" },
				],
			},
		} as Memory;
	}

	function makeVisionRuntime(fetchImpl?: (url: string) => Promise<Response>) {
		const useModelParams: Array<Record<string, unknown>> = [];
		const fetchedUrls: string[] = [];
		const reported: unknown[] = [];
		const runtime = {
			agentId,
			getConversationLength: () => 20,
			getMemories: async () => [],
			getRoom: async () => null,
			logger: { warn: () => undefined, debug: () => undefined },
			getCache: async () => undefined,
			setCache: async () => undefined,
			reportError: (...args: unknown[]) => {
				reported.push(args);
			},
			useModel: async (_type: unknown, params: Record<string, unknown>) => {
				useModelParams.push(params);
				return "described!";
			},
			fetch: fetchImpl
				? (url: string) => {
						fetchedUrls.push(String(url));
						return fetchImpl(String(url));
					}
				: undefined,
		} as unknown as IAgentRuntime;
		return { runtime, useModelParams, fetchedUrls, reported };
	}

	function pngResponse(): Response {
		return new Response(new Uint8Array(PNG_BYTES), {
			status: 200,
			headers: { "content-type": "image/png" },
		});
	}

	it("resolves a relative own-store URL via the local server and passes a data URL to the model", async () => {
		const { runtime, useModelParams, fetchedUrls } = makeVisionRuntime(
			async () => pngResponse(),
		);
		const records = await readAttachmentRecords(
			runtime,
			imageMessage("/api/media/abc.png"),
			"img-1",
		);

		expect(records[0]?.content).toBe("described!");
		expect(fetchedUrls).toHaveLength(1);
		expect(fetchedUrls[0]).toMatch(
			/^http:\/\/localhost:\d+\/api\/media\/abc\.png$/,
		);
		expect(vi.mocked(fetchRemoteMedia)).not.toHaveBeenCalled();
		expect(useModelParams[0]?.imageUrl).toBe(
			`data:image/png;base64,${PNG_BYTES.toString("base64")}`,
		);
	});

	it("treats an absolute URL on the agent's own server origin as trusted-local", async () => {
		const { runtime, useModelParams, fetchedUrls } = makeVisionRuntime(
			async () => pngResponse(),
		);
		const ownUrl = getLocalServerUrl("/api/media/def.png");
		const records = await readAttachmentRecords(
			runtime,
			imageMessage(ownUrl),
			"img-1",
		);

		expect(records[0]?.content).toBe("described!");
		expect(fetchedUrls).toEqual([ownUrl]);
		expect(vi.mocked(fetchRemoteMedia)).not.toHaveBeenCalled();
		expect(String(useModelParams[0]?.imageUrl)).toMatch(
			/^data:image\/png;base64,/,
		);
	});

	it("fetches genuinely remote URLs through the SSRF-guarded fetcher", async () => {
		vi.mocked(fetchRemoteMedia).mockResolvedValueOnce({
			buffer: PNG_BYTES,
			contentType: "image/png",
			fileName: "cat.png",
		});
		const { runtime, useModelParams, fetchedUrls } = makeVisionRuntime(
			async () => pngResponse(),
		);
		const records = await readAttachmentRecords(
			runtime,
			imageMessage("https://example.test/cat.png"),
			"img-1",
		);

		expect(records[0]?.content).toBe("described!");
		expect(fetchedUrls).toHaveLength(0);
		expect(vi.mocked(fetchRemoteMedia)).toHaveBeenCalledTimes(1);
		expect(String(useModelParams[0]?.imageUrl)).toMatch(
			/^data:image\/png;base64,/,
		);
	});

	it("degrades to no description and reports when the guarded fetch rejects", async () => {
		vi.mocked(fetchRemoteMedia).mockRejectedValueOnce(
			new Error("SSRF policy denied host"),
		);
		const { runtime, useModelParams, reported } = makeVisionRuntime(async () =>
			pngResponse(),
		);
		const records = await readAttachmentRecords(
			runtime,
			imageMessage("https://10.0.0.1/internal.png"),
			"img-1",
		);

		expect(records[0]?.content).toBe("");
		expect(useModelParams).toHaveLength(0);
		expect(reported).toHaveLength(1);
	});
});
