/**
 * On-demand transcription coverage for ATTACHMENT action=read on audio/video
 * records with no stored transcript. Deterministic harness — a hand-rolled
 * runtime stub scripts the TRANSCRIPTION call, and core's SSRF-guarded media
 * fetch (the network boundary) is module-mocked; no live model, no network.
 *
 * Regression under test (observed live, trajectories tj-cd2aadf98b0cc7 /
 * tj-cd524c1a710c6a): a video posted while cloud STT was gated off stored no
 * transcript, and every later "can you see that video?" / "can you get one?"
 * dead-ended on the canned "I don't have a transcript for that attachment
 * yet." Contract points (3–6 hardened per #18413):
 *   1. the read path retries transcription live — fetching bytes through the
 *      guarded, size-capped, 30s-bounded fetch and handing the provider a
 *      Buffer (the ingest call shape);
 *   2. provider-unavailable failures report "speech-to-text isn't enabled"
 *      honestly, without leaking internal error prose;
 *   3. TRANSIENT failures (network blip, provider 5xx, fetch-layer errors —
 *      whose messages can echo a hostile remote body) keep the retryable
 *      open-ended "yet" reply — they must NOT claim STT is disabled;
 *   4. relative media-store URLs (`/api/media/<sha256>.<ext>`) use the
 *      trusted local runtime fetch, never the remote-only URL parser;
 *   5. a successful transcript persists into the owning message memory with
 *      `notProcessed` cleared, and a persistence failure never breaks the
 *      reply.
 */
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it, vi } from "vitest";
import type {
	HandlerCallback,
	IAgentRuntime,
	Media,
	Memory,
	UUID,
} from "../../types/index.ts";
import { ContentType, ModelType } from "../../types/index.ts";

const fetchRemoteMediaMock = vi.fn();
vi.mock("../../media/fetch.ts", () => ({
	fetchRemoteMedia: (...args: unknown[]) => fetchRemoteMediaMock(...args),
}));

const { readAttachmentAction } = await import("./readAttachmentAction.ts");

const VIDEO_URL =
	"https://cdn.discordapp.com/attachments/123/456/snaptik_video.mp4";
const VIDEO_BYTES = Buffer.from("fake-video-bytes");
const TRANSCRIPT = "hello from the tiktok video about home servers";
const ANSWER = "It's a short clip about home servers.";

function makeVideoAttachment(overrides: Partial<Media> = {}): Media {
	return {
		id: "video-attachment-1",
		url: VIDEO_URL,
		title: "snaptik_video.mp4",
		source: "discord",
		contentType: ContentType.VIDEO,
		...overrides,
	};
}

type UseModelCall = { modelType: unknown; options: unknown };
type ReportedError = { scope: string; error: unknown };
type MemoryUpdate = Partial<Memory> & { id: UUID };

function makeRuntime(params: {
	agentId: UUID;
	calls: UseModelCall[];
	transcription: (input: unknown) => Promise<string>;
	localFetch?: (input: unknown) => Promise<Response>;
	getMemoryById?: (id: UUID) => Promise<Memory | null>;
	updateMemory?: (patch: MemoryUpdate) => Promise<boolean>;
	reportedErrors?: ReportedError[];
}): IAgentRuntime {
	const runtime = {
		agentId: params.agentId,
		fetch: params.localFetch,
		getConversationLength: () => 8,
		getMemories: async () => [],
		getMemoryById: params.getMemoryById ?? (async () => null),
		updateMemory: params.updateMemory ?? (async () => true),
		getRoom: async () => null,
		getWorld: async () => null,
		getService: () => null,
		getSetting: () => undefined,
		reportError: (scope: string, error: unknown) => {
			params.reportedErrors?.push({ scope, error });
		},
		useModel: async (modelType: unknown, options: unknown) => {
			params.calls.push({ modelType, options });
			if (modelType === ModelType.TRANSCRIPTION) {
				return params.transcription(options);
			}
			return ANSWER;
		},
	};
	return runtime as unknown as IAgentRuntime;
}

async function runRead(params: {
	attachment: Media;
	transcription: (input: unknown) => Promise<string>;
	fetchImpl?: () => Promise<{ buffer: Buffer }>;
	localFetch?: (input: unknown) => Promise<Response>;
	getMemoryById?: (id: UUID) => Promise<Memory | null>;
	updateMemory?: (patch: MemoryUpdate) => Promise<boolean>;
	reportedErrors?: ReportedError[];
	text?: string;
}) {
	fetchRemoteMediaMock.mockReset();
	fetchRemoteMediaMock.mockImplementation(
		params.fetchImpl ?? (async () => ({ buffer: VIDEO_BYTES })),
	);
	const agentId = uuidv4() as UUID;
	const calls: UseModelCall[] = [];
	const runtime = makeRuntime({
		agentId,
		calls,
		transcription: params.transcription,
		localFetch: params.localFetch,
		getMemoryById: params.getMemoryById,
		updateMemory: params.updateMemory,
		reportedErrors: params.reportedErrors,
	});
	const message: Memory = {
		id: uuidv4() as UUID,
		agentId,
		entityId: uuidv4() as UUID,
		roomId: uuidv4() as UUID,
		createdAt: Date.now(),
		content: {
			text: params.text ?? "can you see that video?",
			source: "discord",
			attachments: [params.attachment],
		},
	};
	const callbackTexts: string[] = [];
	const callback: HandlerCallback = async (content) => {
		if (typeof content?.text === "string") callbackTexts.push(content.text);
		return [];
	};
	const result = await readAttachmentAction.handler?.(
		runtime,
		message,
		undefined,
		{
			parameters: { action: "read", attachmentId: params.attachment.id },
		},
		callback,
	);
	return { result, callbackTexts, calls, message };
}

describe("ATTACHMENT read on-demand transcription", () => {
	it("fetches bytes through the guarded capped fetch and answers from the transcript", async () => {
		let providerInput: unknown;
		const { result, callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async (input) => {
				providerInput = input;
				return TRANSCRIPT;
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([ANSWER]);
		// The bytes came through the SSRF-guarded, size-capped media fetch,
		// bounded at the pre-rework 30s so a stalled host cannot hang the turn.
		expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1);
		const fetchArgs = fetchRemoteMediaMock.mock.calls[0]?.[0] as {
			url?: string;
			maxBytes?: number;
			timeoutMs?: number;
		};
		expect(fetchArgs?.url).toBe(VIDEO_URL);
		expect(fetchArgs?.maxBytes).toBe(50 * 1024 * 1024);
		expect(fetchArgs?.timeoutMs).toBe(30_000);
		// The provider received the buffer (ingest call shape), not a URL.
		expect(Buffer.isBuffer(providerInput)).toBe(true);
		// The answering TEXT_SMALL prompt saw the fresh transcript.
		const answerCall = calls.find((c) => c.modelType === ModelType.TEXT_SMALL);
		expect((answerCall?.options as { prompt?: string })?.prompt).toContain(
			TRANSCRIPT,
		);
	});

	it("reports honest unavailability when no TRANSCRIPTION provider can serve", async () => {
		const unavailable = new Error(
			"Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler",
		);
		unavailable.name = "CloudSttUnavailableError";
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => {
				throw unavailable;
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toContain("speech-to-text isn't enabled");
		// Never leak the internal provider prose.
		expect(callbackTexts[0]).not.toContain("falling through");
		expect(callbackTexts[0]).not.toContain("Eliza Cloud");
	});

	it("keeps the retryable 'yet' reply on a TRANSIENT provider failure", async () => {
		const { callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => {
				throw new Error("provider returned 502");
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
		expect(callbackTexts[0]).not.toContain("isn't enabled");
	});

	it("keeps the retryable 'yet' reply when the media fetch itself fails", async () => {
		const { callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => TRANSCRIPT,
			fetchImpl: async () => {
				throw new Error("fetch failed: connect timeout");
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
		// The provider was never reached.
		expect(
			calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
		).toHaveLength(0);
	});

	it("routes a relative media-store URL through the trusted local fetch", async () => {
		const localUrls: string[] = [];
		let providerInput: unknown;
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment({
				url: "/api/media/0a1b2c3d.mp4",
				title: "stored_clip.mp4",
			}),
			transcription: async (input) => {
				providerInput = input;
				return TRANSCRIPT;
			},
			localFetch: async (input) => {
				localUrls.push(String(input));
				return {
					ok: true,
					arrayBuffer: async () => Uint8Array.from(VIDEO_BYTES).buffer,
				} as unknown as Response;
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([ANSWER]);
		// The canonical relative content-store shape must never reach the
		// remote-only URL parser (it cannot parse, which dead-ended every
		// local attachment on the transient-"yet" reply pre-#18413).
		expect(fetchRemoteMediaMock).not.toHaveBeenCalled();
		expect(localUrls).toHaveLength(1);
		expect(localUrls[0]).toMatch(
			/^http:\/\/localhost:\d+\/api\/media\/0a1b2c3d\.mp4$/,
		);
		// The provider received the locally fetched bytes as a Buffer.
		expect(Buffer.isBuffer(providerInput)).toBe(true);
		expect((providerInput as Buffer).equals(VIDEO_BYTES)).toBe(true);
	});

	it("keeps the retryable 'yet' reply when a hostile remote body mimics unavailability prose", async () => {
		// MediaFetchError messages embed up to ~200 chars of the remote response
		// body (media/fetch.ts throwIfHttpError) — a hostile host must not be
		// able to forge the "speech-to-text isn't enabled" reply through it.
		const spoof = new Error(
			"Failed to fetch media from https://cdn.example/clip.mp4: HTTP 503 Service Unavailable; body: transcription not available — falling through to next TRANSCRIPTION handler",
		);
		spoof.name = "MediaFetchError";
		const { callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => TRANSCRIPT,
			fetchImpl: async () => {
				throw spoof;
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
		expect(callbackTexts[0]).not.toContain("isn't enabled");
		expect(
			calls.filter((c) => c.modelType === ModelType.TRANSCRIPTION),
		).toHaveLength(0);
	});

	it("persists a successful transcript into the owning message's stored attachment", async () => {
		const lookups: UUID[] = [];
		const updates: MemoryUpdate[] = [];
		const bystander: Media = {
			id: "image-1",
			url: "/api/media/aabbccdd.png",
			title: "chart.png",
			source: "discord",
			contentType: ContentType.IMAGE,
			text: "a chart",
		};
		const { result, callbackTexts, message } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed: "Video transcription unavailable: provider returned 502",
			}),
			transcription: async () => TRANSCRIPT,
			getMemoryById: async (id) => {
				lookups.push(id);
				return {
					id,
					entityId: id,
					roomId: id,
					content: {
						text: "posted the clip",
						attachments: [
							bystander,
							makeVideoAttachment({
								notProcessed:
									"Video transcription unavailable: provider returned 502",
							}),
						],
					},
				} as Memory;
			},
			updateMemory: async (patch) => {
				updates.push(patch);
				return true;
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([ANSWER]);
		// The stored row that owns the attachment was looked up and rewritten.
		expect(lookups).toEqual([message.id]);
		expect(updates).toHaveLength(1);
		expect(updates[0]?.id).toBe(message.id);
		const persisted = updates[0]?.content?.attachments as Media[];
		expect(persisted).toHaveLength(2);
		// Only the owning attachment entry changed.
		expect(persisted[0]).toEqual(bystander);
		const video = persisted[1] as Media;
		expect(video.id).toBe("video-attachment-1");
		expect(video.text).toBe(TRANSCRIPT);
		expect(video.description).toBe(`Transcript: ${TRANSCRIPT}`);
		expect(video.url).toBe(VIDEO_URL);
		expect(video.title).toBe("snaptik_video.mp4");
		// The stale failure marker is gone, not merely blanked.
		expect("notProcessed" in video).toBe(false);
		// Gathering-layer transport fields never reach storage.
		expect("_messageId" in video).toBe(false);
		expect("_createdAt" in video).toBe(false);
	});

	it("still replies with the transcript when persistence fails", async () => {
		const reportedErrors: ReportedError[] = [];
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => TRANSCRIPT,
			getMemoryById: async (id) =>
				({
					id,
					entityId: id,
					roomId: id,
					content: { attachments: [makeVideoAttachment()] },
				}) as Memory,
			updateMemory: async () => {
				throw new Error("database offline");
			},
			reportedErrors,
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([ANSWER]);
		// The failure is reported diagnostics-style (error-policy:J7), not thrown.
		expect(reportedErrors).toHaveLength(1);
		expect(reportedErrors[0]?.scope).toBe(
			"ReadAttachmentAction.persistTranscript",
		);
	});

	it("reports honest unavailability from an ingest-time failure marker", async () => {
		const { callbackTexts } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed:
					"Video transcription unavailable: Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler",
			}),
			transcription: async () => {
				throw new Error("still down");
			},
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toContain("speech-to-text isn't enabled");
	});

	it("keeps the open-ended reply when transcription returns no speech", async () => {
		const { callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => "",
		});

		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toBe(
			"I don't have a transcript for that attachment yet.",
		);
	});
});
