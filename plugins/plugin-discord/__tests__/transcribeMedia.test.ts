import {
	ContentType,
	type HandlerCallback,
	type IAgentRuntime,
	type Media,
	type Memory,
	type UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { mediaOp } from "../actions/mediaOp";

const AGENT_ID = "11111111-1111-1111-1111-111111111111" as UUID;
const ENTITY_ID = "22222222-2222-2222-2222-222222222222" as UUID;
const ROOM_ID = "33333333-3333-3333-3333-333333333333" as UUID;

function media(overrides: Partial<Media> = {}): Media {
	const contentType = overrides.contentType ?? ContentType.AUDIO;
	const extension = contentType === ContentType.VIDEO ? "webm" : "wav";
	const id = overrides.id ?? `media-${extension}`;
	return {
		id,
		url:
			overrides.url ??
			`https://cdn.discordapp.com/attachments/1/${id}.${extension}`,
		title: overrides.title ?? `${id}.${extension}`,
		source:
			overrides.source ??
			(contentType === ContentType.VIDEO ? "Video" : "Audio"),
		contentType,
		text: overrides.text,
		description: overrides.description,
	};
}

function message(text: string, attachments: Media[] = []): Memory {
	return {
		id: "44444444-4444-4444-4444-444444444444" as UUID,
		agentId: AGENT_ID,
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		createdAt: Date.now(),
		content: {
			text,
			source: "discord",
			attachments,
		},
	};
}

function runtime(recentMessages: Memory[] = []): IAgentRuntime {
	return {
		agentId: AGENT_ID,
		getConversationLength: () => 20,
		getMemories: vi.fn(async () => recentMessages),
		setCache: vi.fn(async () => undefined),
		logger: {
			debug: vi.fn(),
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	} as unknown as IAgentRuntime;
}

async function run(
	request: string,
	attachments: Media[],
	recentMessages: Memory[] = [],
) {
	const testRuntime = runtime(recentMessages);
	const callback = vi.fn(async () => []) as HandlerCallback;
	const result = await mediaOp.handler?.(
		testRuntime,
		message(request, attachments),
		undefined,
		undefined,
		callback,
	);
	return { callback, result, runtime: testRuntime };
}

describe("DISCORD_MEDIA transcribe", () => {
	it("owns the media turn after emitting a transcript or fallback", () => {
		expect(mediaOp.suppressPostActionContinuation).toBe(true);
	});

	it("validates current media attachments without requiring transcription keywords", async () => {
		await expect(
			mediaOp.validate?.(
				runtime(),
				message("what is this?", [media({ text: "hello world" })]),
			),
		).resolves.toBe(true);
	});

	it("uses the current audio attachment transcript directly", async () => {
		const {
			callback,
			result,
			runtime: testRuntime,
		} = await run("what does this say?", [
			media({ id: "voice", text: "hello from the recording" }),
		]);

		expect(callback).toHaveBeenCalledWith({
			text: expect.stringContaining("hello from the recording"),
			actions: ["DISCORD_MEDIA_RESPONSE"],
			source: "discord",
			attachments: [],
		});
		expect(result?.success).toBe(true);
		expect(testRuntime.getMemories).toHaveBeenCalled();
	});

	it("returns a clean fallback when current media has no transcript", async () => {
		const {
			callback,
			result,
			runtime: testRuntime,
		} = await run("what does this audio say?", [media({ text: "" })]);

		expect(callback).toHaveBeenCalledWith({
			text: "I don't have a transcript for that audio attachment yet.",
			actions: ["DISCORD_MEDIA_FAILED"],
			source: "discord",
		});
		expect(result).toEqual({
			success: false,
			text: "I don't have a transcript for that audio attachment yet.",
		});
		expect(testRuntime.setCache).not.toHaveBeenCalled();
	});

	it("includes all current media transcripts when several are attached", async () => {
		const { callback, result } = await run("summarize these clips", [
			media({
				id: "audio-1",
				title: "first.wav",
				text: "first clip says hello",
			}),
			media({
				id: "video-1",
				title: "second.webm",
				contentType: ContentType.VIDEO,
				text: "second clip says goodbye",
			}),
		]);

		expect(result?.success).toBe(true);
		const reply = vi.mocked(callback).mock.calls[0]?.[0]?.text ?? "";
		expect(reply).toContain("Transcript 1: first.wav");
		expect(reply).toContain("first clip says hello");
		expect(reply).toContain("Transcript 2: second.webm");
		expect(reply).toContain("second clip says goodbye");
	});

	it("falls back to the most recent media attachment from memory", async () => {
		const previous = message("", [
			media({ id: "previous-audio", text: "older recording transcript" }),
		]);
		previous.createdAt = Date.now() - 1000;
		const { callback, result } = await run(
			"transcribe the audio",
			[],
			[previous],
		);

		expect(result?.success).toBe(true);
		expect(vi.mocked(callback).mock.calls[0]?.[0]?.text).toContain(
			"older recording transcript",
		);
	});
});
