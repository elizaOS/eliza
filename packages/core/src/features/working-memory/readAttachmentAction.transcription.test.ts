/**
 * Deterministic on-demand transcription coverage for guarded byte loading,
 * capability classification, and durable owning-message enrichment. Network,
 * model, and database boundaries are controlled fakes; no live services run.
 */

import { v4 as uuidv4 } from "uuid";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MediaFetchError } from "../../media/fetch.ts";
import { TRANSCRIPTION_EMPTY_RESULT_MARKER } from "../../media/transcription.ts";
import {
	type RoomHandlerLease,
	RoomHandlerQueue,
} from "../../runtime/room-handler-queue.ts";
import type {
	HandlerCallback,
	IAgentRuntime,
	Media,
	Memory,
	UUID,
} from "../../types/index.ts";
import { ContentType, ModelType } from "../../types/index.ts";

const { fetchRemoteMediaMock } = vi.hoisted(() => ({
	fetchRemoteMediaMock: vi.fn(),
}));
vi.mock("../../media/fetch.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../media/fetch.ts")>()),
	fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMediaMock(...args),
}));

const { readAttachmentAction } = await import("./readAttachmentAction.ts");

const REMOTE_VIDEO_URL =
	"https://cdn.discordapp.com/attachments/123/456/snaptik_video.mp4";
const LOCAL_VIDEO_URL = `/api/media/${"a".repeat(64)}.mp4`;
const VIDEO_BYTES = Buffer.from("fake-video-bytes");
const TRANSCRIPT = "hello from the tiktok video about home servers";
const ANSWER = "It's a short clip about home servers.";

function makeVideoAttachment(overrides: Partial<Media> = {}): Media {
	return {
		id: "video-attachment-1",
		url: REMOTE_VIDEO_URL,
		title: "snaptik_video.mp4",
		source: "discord",
		contentType: ContentType.VIDEO,
		...overrides,
	};
}

type UseModelCall = { modelType: unknown; options: unknown };

function makeHarness(params: {
	attachments: Media[];
	transcription: (input: unknown) => Promise<string>;
	localFetch?: typeof fetch;
	memoryMetadata?: Memory["metadata"];
	dropOwnerAfterUpdate?: boolean;
	asyncContext?: "auto" | "explicit";
	updateThrows?: Error;
	updateSucceeds?: boolean;
	viewerId?: UUID;
}) {
	const agentId = uuidv4() as UUID;
	const ownerId = uuidv4() as UUID;
	const roomId = uuidv4() as UUID;
	const roomHandlerQueue = new RoomHandlerQueue({
		...(params.asyncContext ? { asyncContext: params.asyncContext } : {}),
	});
	let storedMemory: Memory | null = {
		id: uuidv4() as UUID,
		agentId,
		entityId: ownerId,
		roomId,
		createdAt: Date.now() - 1,
		...(params.memoryMetadata ? { metadata: params.memoryMetadata } : {}),
		content: {
			text: "uploaded attachments",
			source: "discord",
			attachments: structuredClone(params.attachments),
		},
	};
	const calls: UseModelCall[] = [];
	let updateCalls = 0;
	const runtime = {
		agentId,
		roomHandlerQueue,
		getConversationLength: () => 8,
		getMemories: async () =>
			storedMemory ? [structuredClone(storedMemory)] : [],
		getMemoryById: async (id: UUID) =>
			storedMemory && id === storedMemory.id
				? structuredClone(storedMemory)
				: null,
		updateMemory: async (update: Partial<Memory> & { id: UUID }) => {
			updateCalls += 1;
			if (params.updateThrows) throw params.updateThrows;
			if (params.updateSucceeds === false) return false;
			if (!storedMemory || update.id !== storedMemory.id) return false;
			storedMemory = {
				...storedMemory,
				...update,
				content: update.content ?? storedMemory.content,
			};
			if (params.dropOwnerAfterUpdate) {
				storedMemory = null;
			}
			return true;
		},
		getRoom: async () => null,
		getWorld: async () => null,
		getService: () => null,
		getSetting: () => undefined,
		reportError: () => {},
		fetch: params.localFetch,
		useModel: async (modelType: unknown, options: unknown) => {
			calls.push({ modelType, options });
			if (modelType === ModelType.TRANSCRIPTION) {
				return params.transcription(options);
			}
			return ANSWER;
		},
	};

	return {
		calls,
		deleteOwner: async (roomHandlerLease?: RoomHandlerLease) => {
			await roomHandlerQueue.withLeases(
				[roomId],
				async (leases) =>
					roomHandlerQueue.withLeaseWrites(leases, async () => {
						storedMemory = null;
					}),
				roomHandlerLease ? { lease: roomHandlerLease } : undefined,
			);
		},
		getStoredMemory: () => {
			if (!storedMemory) throw new Error("Owning message was deleted");
			return structuredClone(storedMemory);
		},
		getUpdateCalls: () => updateCalls,
		hasStoredMemory: () => storedMemory !== null,
		withOwnerRoomLease: async <T>(
			operation: (lease: RoomHandlerLease) => Promise<T>,
		) =>
			roomHandlerQueue.withLeases([roomId], async (leases) => {
				const lease = leases.get(roomId);
				if (!lease) throw new Error("Owner room lease was not acquired");
				return roomHandlerQueue.runInLease(roomId, lease, () =>
					operation(lease),
				);
			}),
		read: async (
			options: {
				text?: string;
				attachmentId?: string;
				currentOwnerMessage?: boolean;
				roomHandlerLease?: RoomHandlerLease;
			} = {},
		) => {
			let message: Memory;
			if (options.currentOwnerMessage) {
				if (!storedMemory) throw new Error("Owning message was deleted");
				message = {
					...structuredClone(storedMemory),
					content: {
						...structuredClone(storedMemory.content),
						text: options.text ?? "show attachment metadata",
					},
				};
			} else {
				message = {
					id: uuidv4() as UUID,
					agentId,
					entityId: params.viewerId ?? ownerId,
					roomId,
					createdAt: Date.now(),
					content: {
						text: options.text ?? "show attachment metadata",
						source: "discord",
					},
				};
			}
			const callbackTexts: string[] = [];
			const callback: HandlerCallback = async (content) => {
				if (typeof content?.text === "string") callbackTexts.push(content.text);
				return [];
			};
			const result = await readAttachmentAction.handler?.(
				runtime as unknown as IAgentRuntime,
				message,
				undefined,
				{
					...(options.roomHandlerLease
						? { roomHandlerLease: options.roomHandlerLease }
						: {}),
					parameters: {
						action: "read",
						...(options.attachmentId
							? { attachmentId: options.attachmentId }
							: {}),
					},
				},
				callback,
			);
			return { result, callbackTexts };
		},
	};
}

describe("ATTACHMENT read on-demand transcription", () => {
	beforeEach(() => {
		fetchRemoteMediaMock.mockReset();
		fetchRemoteMediaMock.mockResolvedValue({ buffer: VIDEO_BYTES });
	});

	it("uses the SSRF-guarded remote loader with the 30s/50MB bounds", async () => {
		const harness = makeHarness({
			attachments: [makeVideoAttachment()],
			transcription: async () => TRANSCRIPT,
		});

		await harness.read({ attachmentId: "video-attachment-1" });

		expect(fetchRemoteMediaMock).toHaveBeenCalledOnce();
		expect(fetchRemoteMediaMock).toHaveBeenCalledWith({
			url: REMOTE_VIDEO_URL,
			maxBytes: 50 * 1024 * 1024,
			timeoutMs: 30_000,
		});
		const transcriptionCall = harness.calls.find(
			(call) => call.modelType === ModelType.TRANSCRIPTION,
		);
		expect(Buffer.isBuffer(transcriptionCall?.options)).toBe(true);
	});

	it("loads a trusted local content-store URL through the runtime fetch", async () => {
		const localFetch = vi.fn(
			async () =>
				new Response(VIDEO_BYTES, {
					status: 200,
					headers: { "content-type": "video/mp4" },
				}),
		);
		const harness = makeHarness({
			attachments: [makeVideoAttachment({ url: LOCAL_VIDEO_URL })],
			transcription: async () => TRANSCRIPT,
			localFetch: localFetch as typeof fetch,
		});

		const { result } = await harness.read({
			attachmentId: "video-attachment-1",
		});

		expect(result?.data?.content).toBe(TRANSCRIPT);
		expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
		expect(localFetch).toHaveBeenCalledOnce();
		expect(String(localFetch.mock.calls[0]?.[0])).toContain(LOCAL_VIDEO_URL);
		expect(localFetch.mock.calls[0]?.[1]).toMatchObject({
			signal: expect.any(AbortSignal),
		});
	});

	it.each([
		"/api/admin/secrets",
		"/api/media/../admin",
		"file:///tmp/audio.mp3",
		"data:audio/mpeg;base64,AAAA",
		"//evil.example/api/media/file.mp3",
	])("rejects non-store local or alternate-scheme URL %s", async (url) => {
		const localFetch = vi.fn();
		const harness = makeHarness({
			attachments: [makeVideoAttachment({ url })],
			transcription: async () => TRANSCRIPT,
			localFetch: localFetch as typeof fetch,
		});

		const { callbackTexts } = await harness.read({
			text: "can you transcribe that?",
			attachmentId: "video-attachment-1",
		});

		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
		expect(localFetch).not.toHaveBeenCalled();
		expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
		expect(harness.calls).toHaveLength(0);
	});

	it("does not treat a hostile 503 body substring as a stored empty-speech result", async () => {
		fetchRemoteMediaMock.mockRejectedValue(
			new MediaFetchError(
				"http_error",
				`HTTP 503 body: ${TRANSCRIPTION_EMPTY_RESULT_MARKER}`,
			),
		);
		const harness = makeHarness({
			attachments: [
				makeVideoAttachment({
					notProcessed: "Video transcription unavailable: stale outage",
				}),
			],
			transcription: async () => TRANSCRIPT,
		});

		const { result, callbackTexts } = await harness.read({
			text: "can you transcribe that?",
			attachmentId: "video-attachment-1",
		});

		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
		expect(result?.data?.attachment?.notProcessed).toBeUndefined();
		expect(fetchRemoteMediaMock).toHaveBeenCalledOnce();
		expect(harness.calls).toHaveLength(0);
	});

	it("rethrows an unexpected byte-loader failure to the action boundary", async () => {
		fetchRemoteMediaMock.mockRejectedValue(
			new Error("remote media loader invariant failed"),
		);
		const harness = makeHarness({
			attachments: [makeVideoAttachment()],
			transcription: async () => TRANSCRIPT,
		});

		const { result, callbackTexts } = await harness.read({
			attachmentId: "video-attachment-1",
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toContain("remote media loader invariant failed");
		expect(callbackTexts).toEqual([
			"I couldn't read that attachment right now.",
		]);
		expect(harness.calls).toHaveLength(0);
	});

	it("does not degrade a deterministic byte-cap failure as retryable absence", async () => {
		fetchRemoteMediaMock.mockRejectedValue(
			new MediaFetchError("max_bytes", "attachment exceeds 50MB"),
		);
		const harness = makeHarness({
			attachments: [makeVideoAttachment()],
			transcription: async () => TRANSCRIPT,
		});

		const { result, callbackTexts } = await harness.read({
			attachmentId: "video-attachment-1",
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toContain("attachment exceeds 50MB");
		expect(callbackTexts).toEqual([
			"I couldn't read that attachment right now.",
		]);
	});

	it("shadows stale capability state when the current provider fails transiently", async () => {
		const harness = makeHarness({
			attachments: [
				makeVideoAttachment({
					notProcessed: "Video transcription unavailable: stale outage",
				}),
			],
			transcription: async () => {
				throw new Error("provider returned 502");
			},
		});

		const { result, callbackTexts } = await harness.read({
			text: "can you transcribe that?",
			attachmentId: "video-attachment-1",
		});

		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
		expect(result?.data?.attachment?.notProcessed).toBeUndefined();
	});

	it("does not persist a redacted derivative transcript onto its source", async () => {
		const viewerId = uuidv4() as UUID;
		const harness = makeHarness({
			attachments: [
				makeVideoAttachment({
					redactedUrl: "https://cdn.example.test/redacted-video.mp4",
				}),
			],
			memoryMetadata: {
				scope: "owner-private",
				share: { grants: [{ entityId: viewerId, mode: "redacted" }] },
			},
			transcription: async () => TRANSCRIPT,
			viewerId,
		});

		const { callbackTexts } = await harness.read({
			text: "can you transcribe that?",
			attachmentId: "video-attachment-1",
		});

		expect(callbackTexts).toEqual([
			"I don't have a transcript for that attachment yet.",
		]);
		expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
		expect(harness.calls).toHaveLength(0);
		expect(
			harness.getStoredMemory().content.attachments?.[0]?.text,
		).toBeUndefined();
	});

	it("persists a transcript and repeats with zero byte or model work", async () => {
		const harness = makeHarness({
			attachments: [
				makeVideoAttachment({
					notProcessed: "Video transcription unavailable: provider warming",
				}),
			],
			transcription: async () => TRANSCRIPT,
		});

		const first = await harness.read({ attachmentId: "video-attachment-1" });
		expect(first.result?.data?.content).toBe(TRANSCRIPT);
		expect(harness.getStoredMemory().content.attachments?.[0]).toMatchObject({
			text: TRANSCRIPT,
			description: `Transcript: ${TRANSCRIPT}`,
		});
		expect(
			harness.getStoredMemory().content.attachments?.[0]?.notProcessed,
		).toBeUndefined();
		expect(first.result?.data?.attachment).toEqual(
			harness.getStoredMemory().content.attachments?.[0],
		);
		expect(
			Object.hasOwn(first.result?.data?.attachment ?? {}, "notProcessed"),
		).toBe(false);

		const second = await harness.read({ attachmentId: "video-attachment-1" });
		expect(second.result?.data?.content).toBe(TRANSCRIPT);
		expect(fetchRemoteMediaMock).toHaveBeenCalledOnce();
		expect(harness.calls).toHaveLength(1);
		expect(harness.calls[0]?.modelType).toBe(ModelType.TRANSCRIPTION);
	});

	it("merges sibling transcripts under one explicitly propagated room lease", async () => {
		let transcriptionStarts = 0;
		let releaseTranscriptions = () => {};
		const bothTranscriptionsStarted = new Promise<void>((resolve) => {
			releaseTranscriptions = resolve;
		});
		fetchRemoteMediaMock.mockImplementation(
			async ({ url }: { url: string }) => ({
				buffer: Buffer.from(url.endsWith("a.mp4") ? "alpha" : "beta"),
			}),
		);
		const harness = makeHarness({
			attachments: [
				makeVideoAttachment({
					id: "video-a",
					url: "https://example.test/a.mp4",
				}),
				makeVideoAttachment({
					id: "video-b",
					url: "https://example.test/b.mp4",
				}),
			],
			transcription: async (input) => {
				transcriptionStarts += 1;
				if (transcriptionStarts === 2) releaseTranscriptions();
				await bothTranscriptionsStarted;
				return (input as Buffer).toString("utf8");
			},
			asyncContext: "explicit",
		});

		const [readA, readB] = await harness.withOwnerRoomLease((lease) =>
			Promise.all([
				harness.read({
					attachmentId: "video-a",
					roomHandlerLease: lease,
				}),
				harness.read({
					attachmentId: "video-b",
					roomHandlerLease: lease,
				}),
			]),
		);
		const durableAttachments = harness.getStoredMemory().content.attachments;

		expect(durableAttachments?.map(({ id, text }) => ({ id, text }))).toEqual([
			{ id: "video-a", text: "alpha" },
			{ id: "video-b", text: "beta" },
		]);
		expect(readA.result?.data?.attachment).toEqual(durableAttachments?.[0]);
		expect(readB.result?.data?.attachment).toEqual(durableAttachments?.[1]);
		expect(harness.getUpdateCalls()).toBe(2);
	});

	it("serializes deletion ahead of persistence under an explicit room lease", async () => {
		let markTranscriptionStarted = () => {};
		const transcriptionStarted = new Promise<void>((resolve) => {
			markTranscriptionStarted = resolve;
		});
		let releaseTranscription = () => {};
		const transcriptionRelease = new Promise<void>((resolve) => {
			releaseTranscription = resolve;
		});
		const harness = makeHarness({
			attachments: [makeVideoAttachment()],
			asyncContext: "explicit",
			transcription: async () => {
				markTranscriptionStarted();
				await transcriptionRelease;
				return TRANSCRIPT;
			},
		});

		const { result, callbackTexts } = await harness.withOwnerRoomLease(
			async (lease) => {
				const pendingRead = harness.read({
					text: "can you transcribe that?",
					attachmentId: "video-attachment-1",
					roomHandlerLease: lease,
				});
				await transcriptionStarted;
				await harness.deleteOwner(lease);
				releaseTranscription();
				return pendingRead;
			},
		);

		expect(callbackTexts).toEqual([
			"I couldn't read that attachment right now.",
		]);
		expect(result?.success).toBe(false);
		expect(result?.error).toContain("is no longer available");
		expect(harness.hasStoredMemory()).toBe(false);
		expect(harness.getUpdateCalls()).toBe(0);
	});

	it("rejects a false-positive update when the owner disappears before verification", async () => {
		const harness = makeHarness({
			attachments: [makeVideoAttachment()],
			dropOwnerAfterUpdate: true,
			transcription: async () => TRANSCRIPT,
		});

		const { result, callbackTexts } = await harness.read({
			text: "can you transcribe that?",
			attachmentId: "video-attachment-1",
		});

		expect(callbackTexts).toEqual([
			"I couldn't read that attachment right now.",
		]);
		expect(result?.success).toBe(false);
		expect(result?.error).toContain("disappeared during");
		expect(harness.hasStoredMemory()).toBe(false);
		expect(harness.getUpdateCalls()).toBe(1);
	});

	it("surfaces an owning-message write rejection at the action boundary", async () => {
		const harness = makeHarness({
			attachments: [makeVideoAttachment()],
			transcription: async () => TRANSCRIPT,
			updateSucceeds: false,
		});

		const { result, callbackTexts } = await harness.read({
			text: "can you transcribe that?",
			attachmentId: "video-attachment-1",
		});

		expect(callbackTexts).toEqual([
			"I couldn't read that attachment right now.",
		]);
		expect(result?.success).toBe(false);
		expect(result?.error).toContain("rejected its attachment update");
		expect(
			harness.getStoredMemory().content.attachments?.[0]?.text,
		).toBeUndefined();
	});

	it("surfaces an adapter update exception at the action boundary", async () => {
		const harness = makeHarness({
			attachments: [makeVideoAttachment()],
			transcription: async () => TRANSCRIPT,
			updateThrows: new Error("database write failed"),
		});

		const { result, callbackTexts } = await harness.read({
			attachmentId: "video-attachment-1",
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toContain("database write failed");
		expect(callbackTexts).toEqual([
			"I couldn't read that attachment right now.",
		]);
		expect(harness.getUpdateCalls()).toBe(1);
	});

	it("retries missing media in a mixed readable selection", async () => {
		const harness = makeHarness({
			attachments: [
				{
					id: "readable-document",
					url: `/api/media/${"b".repeat(64)}.txt`,
					contentType: ContentType.DOCUMENT,
					text: "already readable notes",
				},
				makeVideoAttachment(),
			],
			transcription: async () => TRANSCRIPT,
		});

		const { result } = await harness.read({ currentOwnerMessage: true });

		expect(result?.data?.contents).toEqual([
			"already readable notes",
			TRANSCRIPT,
		]);
		expect(fetchRemoteMediaMock).toHaveBeenCalledOnce();
		expect(harness.getStoredMemory().content.attachments?.[1]?.text).toBe(
			TRANSCRIPT,
		);
	});

	it("replaces stale unavailability with a durable empty-speech state", async () => {
		const harness = makeHarness({
			attachments: [
				makeVideoAttachment({
					notProcessed: "Video transcription unavailable: old provider outage",
				}),
			],
			transcription: async () => "   ",
		});

		const first = await harness.read({
			text: "can you transcribe that?",
			attachmentId: "video-attachment-1",
		});

		expect(first.callbackTexts).toEqual([
			"I couldn't find any speech to transcribe in that attachment.",
		]);
		expect(first.result?.data?.content).toBe("");
		expect(harness.getStoredMemory().content.attachments?.[0]).toMatchObject({
			notProcessed: TRANSCRIPTION_EMPTY_RESULT_MARKER,
		});
		expect(
			harness.getStoredMemory().content.attachments?.[0]?.text,
		).toBeUndefined();
		expect(first.result?.data?.attachment).toEqual(
			harness.getStoredMemory().content.attachments?.[0],
		);

		const second = await harness.read({
			text: "can you transcribe that?",
			attachmentId: "video-attachment-1",
		});
		expect(second.callbackTexts).toEqual(first.callbackTexts);
		expect(fetchRemoteMediaMock).toHaveBeenCalledOnce();
		expect(harness.calls).toHaveLength(1);
	});

	it("reports provider unavailability without leaking internal prose", async () => {
		const unavailable = new Error(
			"Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler",
		);
		unavailable.name = "CloudSttUnavailableError";
		const harness = makeHarness({
			attachments: [makeVideoAttachment()],
			transcription: async () => {
				throw unavailable;
			},
		});

		const { callbackTexts } = await harness.read({
			text: "can you transcribe that?",
			attachmentId: "video-attachment-1",
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toContain("speech-to-text isn't enabled");
		expect(callbackTexts[0]).not.toContain("falling through");
		expect(callbackTexts[0]).not.toContain("Eliza Cloud");
	});
});
