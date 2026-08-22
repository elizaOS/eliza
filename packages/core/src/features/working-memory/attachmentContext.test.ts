/**
 * Deterministic coverage for conversation attachment gathering: access-scoped
 * message rows must be filtered before the ATTACHMENT action can read stored
 * text or original URLs. The harness stubs runtime memory/world access; no live
 * model or database is involved.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
import { readAttachmentAction } from "./readAttachmentAction.ts";

const agentId = "00000000-0000-0000-0000-0000000000a9" as UUID;
const userId = "00000000-0000-0000-0000-000000000002" as UUID;
const ownerId = "00000000-0000-0000-0000-000000000003" as UUID;
const roomId = "00000000-0000-0000-0000-000000000004" as UUID;
const worldId = "00000000-0000-0000-0000-00000000000a" as UUID;

function makeRuntime(recentMessages: Memory[]): IAgentRuntime {
	return {
		agentId,
		getConversationLength: () => 20,
		getMemories: async () => recentMessages,
		getRoom: async () => ({ id: roomId, worldId }),
		getWorld: async () => ({
			id: worldId,
			agentId,
			metadata: { roles: { [userId]: "USER" } },
		}),
		getService: () => null,
		logger: { warn: () => undefined },
	} as unknown as IAgentRuntime;
}

function viewerMessage(text = "read the attachment"): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000005" as UUID,
		entityId: userId,
		roomId,
		worldId,
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

function fullGrantPrivateAttachmentMemory(): Memory {
	const memory = privateAttachmentMemory(false);
	memory.metadata = {
		...memory.metadata,
		share: { grants: [{ entityId: userId, mode: "full" }] },
	};
	return memory;
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

	it("rechecks disclosure on every action page and blocks a continuation after revocation", async () => {
		let recentMessages = [fullGrantPrivateAttachmentMemory()];
		const modelCalls: string[] = [];
		const runtime = {
			...makeRuntime(recentMessages),
			getMemories: async () => recentMessages,
			getSetting: () => undefined,
			getService: () => null,
			reportError: () => undefined,
			useModel: async (_type: unknown, params: { prompt: string }) => {
				modelCalls.push(params.prompt);
				return "authorized answer";
			},
		} as unknown as IAgentRuntime;
		const first = await readAttachmentAction.handler?.(
			runtime,
			viewerMessage(),
			undefined,
			{
				parameters: {
					action: "read",
					attachmentId: "private-image",
					limit: 8,
				},
			},
		);
		expect(first?.success).toBe(true);
		expect(first?.text).toBe("full ext");
		const revision = (
			first?.data as { readView: { slice: { revision?: string } } } | undefined
		)?.readView.slice.revision;

		recentMessages = [privateAttachmentMemory(false)];
		const revoked = await readAttachmentAction.handler?.(
			runtime,
			viewerMessage(),
			undefined,
			{
				parameters: {
					action: "read",
					attachmentId: "private-image",
					offset: 8,
					limit: 8,
					expectedRevision: revision,
				},
			},
		);
		expect(revoked?.success).toBe(false);
		expect(revoked?.error).toBe("ATTACHMENT_UNAVAILABLE_OR_UNAUTHORIZED");
		expect(revoked?.values).toMatchObject({ awaitingSelection: false });
		expect(revoked?.text).not.toContain("racted text");
		expect(modelCalls).toHaveLength(1);
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
	const CANONICAL_NAME = `${"a".repeat(64)}.png`;

	beforeEach(() => {
		vi.mocked(fetchRemoteMedia).mockClear();
	});

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

	function pngResponse(status = 200): Response {
		return new Response(status === 200 ? new Uint8Array(PNG_BYTES) : null, {
			status,
			headers: { "content-type": "image/png" },
		});
	}

	const UNAVAILABLE = "An image attachment (image bytes unavailable)";

	it("resolves a canonical relative own-store handle via the local server and passes a data URL to the model", async () => {
		const { runtime, useModelParams, fetchedUrls } = makeVisionRuntime(
			async () => pngResponse(),
		);
		const records = await readAttachmentRecords(
			runtime,
			imageMessage(`/api/media/${CANONICAL_NAME}`),
			"img-1",
		);

		expect(records[0]?.content).toBe("described!");
		expect(fetchedUrls).toHaveLength(1);
		expect(fetchedUrls[0]).toBe(
			`http://localhost:3000/api/media/${CANONICAL_NAME}`,
		);
		expect(vi.mocked(fetchRemoteMedia)).not.toHaveBeenCalled();
		expect(useModelParams[0]?.imageUrl).toBe(
			`data:image/png;base64,${PNG_BYTES.toString("base64")}`,
		);
	});

	it("treats a canonical absolute handle on the agent's own server origin as trusted-local", async () => {
		const { runtime, useModelParams, fetchedUrls } = makeVisionRuntime(
			async () => pngResponse(),
		);
		const ownUrl = getLocalServerUrl(`/api/media/${CANONICAL_NAME}`);
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

	it("rejects a non-canonical relative path without acquiring runtime fetch authority", async () => {
		const { runtime, useModelParams, fetchedUrls, reported } =
			makeVisionRuntime(async () => pngResponse());
		const records = await readAttachmentRecords(
			runtime,
			imageMessage("/api/agents/secret-admin-view"),
			"img-1",
		);

		expect(records[0]?.content).toBe(UNAVAILABLE);
		expect(fetchedUrls).toHaveLength(0);
		expect(vi.mocked(fetchRemoteMedia)).not.toHaveBeenCalled();
		expect(useModelParams).toHaveLength(0);
		expect(reported).toHaveLength(1);
	});

	it("rejects an own-origin URL that is not a canonical store handle", async () => {
		const { runtime, useModelParams, fetchedUrls, reported } =
			makeVisionRuntime(async () => pngResponse());
		const records = await readAttachmentRecords(
			runtime,
			imageMessage(
				`${getLocalServerUrl(`/api/media/${CANONICAL_NAME}`)}?token=x`,
			),
			"img-1",
		);

		expect(records[0]?.content).toBe(UNAVAILABLE);
		expect(fetchedUrls).toHaveLength(0);
		expect(useModelParams).toHaveLength(0);
		expect(reported).toHaveLength(1);
	});

	it("degrades to the visible bytes-unavailable state on a non-2xx local fetch", async () => {
		const { runtime, useModelParams, reported } = makeVisionRuntime(async () =>
			pngResponse(503),
		);
		const records = await readAttachmentRecords(
			runtime,
			imageMessage(`/api/media/${CANONICAL_NAME}`),
			"img-1",
		);

		expect(records[0]?.content).toBe(UNAVAILABLE);
		expect(useModelParams).toHaveLength(0);
		expect(reported).toHaveLength(1);
	});

	it("degrades to the visible bytes-unavailable state and reports when the guarded fetch rejects", async () => {
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

		expect(records[0]?.content).toBe(UNAVAILABLE);
		expect(useModelParams).toHaveLength(0);
		expect(reported).toHaveLength(1);
	});
});
