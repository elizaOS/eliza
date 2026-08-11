/**
 * On-demand transcription coverage for ATTACHMENT action=read on audio/video
 * records with no stored transcript. Deterministic harness — a hand-rolled
 * runtime stub scripts the TRANSCRIPTION and TEXT_SMALL calls; no module
 * mocks and no live model.
 *
 * Regression under test (observed live, trajectories tj-cd2aadf98b0cc7 /
 * tj-cd524c1a710c6a): a video posted while cloud STT was gated off stored no
 * transcript, and every later "can you see that video?" / "can you get one?"
 * dead-ended on the canned "I don't have a transcript for that attachment
 * yet." — even though the planner ran ATTACHMENT read successfully each time.
 * The read path must (1) retry transcription live when a provider can serve,
 * and (2) report unavailability honestly instead of an open-ended "yet".
 */
import { v4 as uuidv4 } from "uuid";
import { describe, expect, it } from "vitest";
import type {
	HandlerCallback,
	IAgentRuntime,
	Media,
	Memory,
	UUID,
} from "../../types/index.ts";
import { ContentType, ModelType } from "../../types/index.ts";
import { readAttachmentAction } from "./readAttachmentAction.ts";

const VIDEO_URL =
	"https://cdn.discordapp.com/attachments/123/456/snaptik_video.mp4";
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
	transcription: () => Promise<string>;
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
				return params.transcription();
			}
			return ANSWER;
		},
	};
	return runtime as unknown as IAgentRuntime;
}

async function runRead(params: {
	attachment: Media;
	transcription: () => Promise<string>;
	text?: string;
}) {
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
	it("transcribes a media record live and answers from the transcript", async () => {
		const { result, callbackTexts, calls } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => TRANSCRIPT,
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toEqual([ANSWER]);
		// The TRANSCRIPTION call targeted the stored attachment URL.
		const sttCall = calls.find((c) => c.modelType === ModelType.TRANSCRIPTION);
		expect((sttCall?.options as { audioUrl?: string })?.audioUrl).toBe(
			VIDEO_URL,
		);
		// The answering TEXT_SMALL prompt saw the fresh transcript.
		const answerCall = calls.find((c) => c.modelType === ModelType.TEXT_SMALL);
		expect((answerCall?.options as { prompt?: string })?.prompt).toContain(
			TRANSCRIPT,
		);
	});

	it("reports honest unavailability when no TRANSCRIPTION provider can serve", async () => {
		const { result, callbackTexts } = await runRead({
			attachment: makeVideoAttachment(),
			transcription: async () => {
				throw new Error(
					"Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler",
				);
			},
		});

		expect(result?.success).toBe(true);
		expect(callbackTexts).toHaveLength(1);
		expect(callbackTexts[0]).toContain("speech-to-text isn't enabled");
		// Never leak the internal provider prose.
		expect(callbackTexts[0]).not.toContain("falling through");
		expect(callbackTexts[0]).not.toContain("Eliza Cloud");
	});

	it("reports honest unavailability from an ingest-time failure marker", async () => {
		const { callbackTexts } = await runRead({
			attachment: makeVideoAttachment({
				notProcessed:
					"Video transcription unavailable: Eliza Cloud STT is not available — falling through to next TRANSCRIPTION handler",
			}),
			transcription: async () => {
				throw new Error("still unavailable");
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
