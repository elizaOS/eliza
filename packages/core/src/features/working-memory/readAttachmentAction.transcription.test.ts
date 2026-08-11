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
 * yet." Contract points:
 *   1. the read path retries transcription live — fetching bytes through the
 *      guarded, size-capped fetch and handing the provider a Buffer (the
 *      ingest call shape);
 *   2. provider-unavailable failures report "speech-to-text isn't enabled"
 *      honestly, without leaking internal error prose;
 *   3. TRANSIENT failures (network blip, provider 5xx) keep the retryable
 *      open-ended "yet" reply — they must NOT claim STT is disabled.
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

function makeRuntime(params: {
	agentId: UUID;
	calls: UseModelCall[];
	transcription: (input: unknown) => Promise<string>;
}): IAgentRuntime {
	const runtime = {
		agentId: params.agentId,
		getConversationLength: () => 8,
		getMemories: async () => [],
		getRoom: async () => null,
		getWorld: async () => null,
		getService: () => null,
		getSetting: () => undefined,
		reportError: () => {},
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
	return { result, callbackTexts, calls };
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
		// The bytes came through the SSRF-guarded, size-capped media fetch.
		expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1);
		const fetchArgs = fetchRemoteMediaMock.mock.calls[0]?.[0] as {
			url?: string;
			maxBytes?: number;
		};
		expect(fetchArgs?.url).toBe(VIDEO_URL);
		expect(fetchArgs?.maxBytes).toBe(50 * 1024 * 1024);
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
