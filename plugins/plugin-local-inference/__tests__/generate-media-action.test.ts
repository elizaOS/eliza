/**
 * Tests for the unified `GENERATE_MEDIA` agent action.
 *
 * Coverage:
 *   - Intent detection: keyword paths for draw / picture / photo / say /
 *     speak / video, plus a TEXT_SMALL-classifier fallback for ambiguous
 *     prompts.
 *   - Dispatch routing for IMAGE (PNG data URL → attachment with mime).
 *   - Dispatch routing for TEXT_TO_SPEECH (raw bytes → audio attachment).
 *   - Video kind → graceful refusal (no model call).
 *   - Arbiter / backend unavailable → graceful error result (not a throw).
 *
 * All `runtime.useModel` calls are mocked. The action runs in pure JS,
 * so these tests run on hosts without a GPU / native TTS binary.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type IAgentRuntime,
	type ImageGenerationResult,
	type Memory,
	ModelType,
	type UUID,
} from "@elizaos/core";
import {
	buildGenerateMediaHandler,
	detectMediaIntent,
	generateMediaAction,
} from "../src/actions/generate-media.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_PNG_BYTES = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
]);

function fakePngDataUrl(): string {
	return `data:image/png;base64,${Buffer.from(FAKE_PNG_BYTES).toString("base64")}`;
}

// Minimal 1-frame "WAV" buffer: RIFF + WAVE + fmt chunk + data chunk header
// + 4 bytes of PCM. Enough for mime sniffing + a non-empty Uint8Array.
const FAKE_WAV_BYTES = (() => {
	const buf = Buffer.alloc(44 + 4);
	buf.write("RIFF", 0, 4);
	buf.writeUInt32LE(40 + 4, 4);
	buf.write("WAVE", 8, 4);
	buf.write("fmt ", 12, 4);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(16000, 24);
	buf.writeUInt32LE(16000, 28);
	buf.writeUInt16LE(1, 32);
	buf.writeUInt16LE(8, 34);
	buf.write("data", 36, 4);
	buf.writeUInt32LE(4, 40);
	buf.writeUInt8(0x10, 44);
	buf.writeUInt8(0x20, 45);
	buf.writeUInt8(0x30, 46);
	buf.writeUInt8(0x40, 47);
	return new Uint8Array(buf);
})();

interface MockUseModelOptions {
	imageResult?: ImageGenerationResult[];
	imageError?: Error;
	audioResult?: Uint8Array;
	audioError?: Error;
	textSmallReturn?: string;
}

function makeRuntime(options: MockUseModelOptions = {}) {
	const useModel = vi.fn(async (modelType: string, _params: unknown) => {
		if (modelType === ModelType.IMAGE) {
			if (options.imageError) throw options.imageError;
			return options.imageResult ?? [{ url: fakePngDataUrl() }];
		}
		if (modelType === ModelType.TEXT_TO_SPEECH) {
			if (options.audioError) throw options.audioError;
			return options.audioResult ?? FAKE_WAV_BYTES;
		}
		if (modelType === ModelType.TEXT_SMALL) {
			return options.textSmallReturn ?? '{"kind":"none"}';
		}
		throw new Error(`unexpected modelType in test: ${modelType}`);
	});
	const runtime = {
		useModel,
	} as unknown as IAgentRuntime;
	return { runtime, useModel };
}

function makeMessage(text: string): Memory {
	return {
		entityId: "00000000-0000-0000-0000-000000000001" as UUID,
		roomId: "00000000-0000-0000-0000-000000000002" as UUID,
		content: { text },
	};
}

// ---------------------------------------------------------------------------
// Intent detection
// ---------------------------------------------------------------------------

describe("GENERATE_MEDIA — intent detection", () => {
	it('classifies "draw me a sunset" as image with stripped prompt', async () => {
		const result = await detectMediaIntent("Draw me a sunset over the lake.");
		expect(result).not.toBeNull();
		expect(result?.kind).toBe("image");
		expect(result?.source).toBe("keyword");
		expect(result?.prompt.toLowerCase()).toContain("sunset");
		expect(result?.prompt.toLowerCase()).not.toMatch(/^draw\b/);
	});

	it('classifies "a picture of a cat" as image', async () => {
		const result = await detectMediaIntent("Show me a picture of a cat.");
		expect(result?.kind).toBe("image");
	});

	it('classifies "generate a photo of mountains" as image', async () => {
		const result = await detectMediaIntent("Generate a photo of mountains at dawn.");
		expect(result?.kind).toBe("image");
		expect(result?.prompt.toLowerCase()).toContain("mountains");
	});

	it('classifies "say hello in spanish" as audio', async () => {
		const result = await detectMediaIntent("Say hello in spanish.");
		expect(result?.kind).toBe("audio");
		expect(result?.source).toBe("keyword");
		// Expect at least the literal we want spoken to survive after strip.
		expect(result?.prompt.toLowerCase()).toContain("hello");
	});

	it('classifies "speak this aloud: foo" as audio', async () => {
		const result = await detectMediaIntent("Speak this aloud: foo bar baz");
		expect(result?.kind).toBe("audio");
		expect(result?.prompt).toContain("foo bar baz");
	});

	it('classifies "make a video of a cat" as video', async () => {
		const result = await detectMediaIntent("Make a video of a cat dancing");
		expect(result?.kind).toBe("video");
	});

	it("returns null when keywords don't match and no classifier is provided", async () => {
		const result = await detectMediaIntent("What's the weather today?");
		expect(result).toBeNull();
	});

	it("falls back to the classifier when keywords don't match", async () => {
		const classifier = vi.fn().mockResolvedValue("image");
		const result = await detectMediaIntent(
			"Give me a vibrant impression of a forest at sunset.",
			{ classifier },
		);
		expect(classifier).toHaveBeenCalledTimes(1);
		expect(result?.kind).toBe("image");
		expect(result?.source).toBe("classifier");
		expect(result?.prompt).toMatch(/forest/);
	});

	it("returns null when the classifier yields 'none'", async () => {
		const classifier = vi.fn().mockResolvedValue(null);
		const result = await detectMediaIntent("ambiguous text", { classifier });
		expect(result).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// Dispatch routing
// ---------------------------------------------------------------------------

describe("GENERATE_MEDIA — image dispatch", () => {
	it("calls ModelType.IMAGE and returns an image attachment", async () => {
		const { runtime, useModel } = makeRuntime();
		const handler = buildGenerateMediaHandler();
		const captured: unknown[] = [];
		const result = await handler(
			runtime,
			makeMessage("Draw me a sunset over a mountain lake."),
			undefined,
			undefined,
			async (content) => {
				captured.push(content);
				return [];
			},
		);
		expect(result.success).toBe(true);
		expect(result.userFacingText).toMatch(/image/i);
		expect(result.data?.computerUseAction).toBe("GENERATE_MEDIA_IMAGE");
		expect(result.data?.mime).toBe("image/png");
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.IMAGE);
		// IMAGE params include the stripped prompt.
		const imageParams = useModel.mock.calls[0]?.[1] as { prompt?: string };
		expect(imageParams.prompt?.toLowerCase()).toContain("sunset");
		// Callback got an attachment.
		expect(captured).toHaveLength(1);
		const callbackContent = captured[0] as {
			text?: string;
			attachments?: { contentType?: string; url?: string }[];
		};
		expect(callbackContent.attachments?.[0]?.contentType).toBe("image");
		expect(callbackContent.attachments?.[0]?.url).toMatch(/^data:image\/png;base64,/);
	});

	it("surfaces a backend failure as a failed ActionResult (not a throw)", async () => {
		const { runtime } = makeRuntime({
			imageError: new Error("LOCAL_INFERENCE_UNAVAILABLE: no arbiter"),
		});
		const handler = buildGenerateMediaHandler();
		const result = await handler(
			runtime,
			makeMessage("Draw a cyberpunk city."),
		);
		expect(result.success).toBe(false);
		expect(result.data?.computerUseAction).toBe("GENERATE_MEDIA_IMAGE_FAILED");
		expect(result.error).toBeInstanceOf(Error);
		expect(String(result.text)).toMatch(/Image generation failed/);
	});
});

describe("GENERATE_MEDIA — audio dispatch", () => {
	it("calls ModelType.TEXT_TO_SPEECH and returns an audio attachment", async () => {
		const { runtime, useModel } = makeRuntime();
		const handler = buildGenerateMediaHandler();
		const captured: unknown[] = [];
		const result = await handler(
			runtime,
			makeMessage("Say hello in spanish."),
			undefined,
			undefined,
			async (content) => {
				captured.push(content);
				return [];
			},
		);
		expect(result.success).toBe(true);
		expect(result.data?.computerUseAction).toBe("GENERATE_MEDIA_AUDIO");
		expect(result.data?.mime).toBe("audio/wav");
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.TEXT_TO_SPEECH);
		const ttsParams = useModel.mock.calls[0]?.[1] as { text?: string };
		expect(ttsParams.text?.toLowerCase()).toContain("hello");
		expect(captured).toHaveLength(1);
		const cb = captured[0] as {
			attachments?: { contentType?: string; url?: string }[];
		};
		expect(cb.attachments?.[0]?.contentType).toBe("audio");
		expect(cb.attachments?.[0]?.url).toMatch(/^data:audio\/wav;base64,/);
	});

	it("treats raw PCM bytes (no RIFF header) as audio/pcm", async () => {
		const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
		const { runtime } = makeRuntime({ audioResult: pcm });
		const handler = buildGenerateMediaHandler();
		const result = await handler(
			runtime,
			makeMessage("Speak this aloud: foo"),
		);
		expect(result.success).toBe(true);
		expect(result.data?.mime).toBe("audio/pcm");
		expect(result.data?.byteLength).toBe(8);
	});
});

describe("GENERATE_MEDIA — video unsupported", () => {
	it("refuses video requests cleanly without calling useModel", async () => {
		const { runtime, useModel } = makeRuntime();
		const handler = buildGenerateMediaHandler();
		const result = await handler(
			runtime,
			makeMessage("Make a video of a cat dancing."),
		);
		expect(result.success).toBe(false);
		expect(result.data?.computerUseAction).toBe(
			"GENERATE_MEDIA_VIDEO_UNSUPPORTED",
		);
		expect(result.text).toMatch(/not yet supported/);
		expect(useModel).not.toHaveBeenCalled();
	});
});

describe("GENERATE_MEDIA — ambiguous / empty input", () => {
	it("uses the TEXT_SMALL classifier fallback when keywords don't match", async () => {
		const { runtime, useModel } = makeRuntime({
			textSmallReturn: '{"kind":"image"}',
		});
		const handler = buildGenerateMediaHandler();
		const result = await handler(
			runtime,
			makeMessage("A serene forest at dawn with morning mist"),
		);
		expect(result.success).toBe(true);
		// First call was TEXT_SMALL (classifier), second was IMAGE.
		expect(useModel.mock.calls[0]?.[0]).toBe(ModelType.TEXT_SMALL);
		expect(useModel.mock.calls[1]?.[0]).toBe(ModelType.IMAGE);
	});

	it("returns a graceful error when classifier returns 'none'", async () => {
		const { runtime } = makeRuntime({
			textSmallReturn: '{"kind":"none"}',
		});
		const handler = buildGenerateMediaHandler();
		const result = await handler(
			runtime,
			makeMessage("Tell me a joke please."),
		);
		expect(result.success).toBe(false);
		expect(result.data?.computerUseAction).toBe("GENERATE_MEDIA_AMBIGUOUS");
	});

	it("returns a graceful error for empty messages", async () => {
		const { runtime, useModel } = makeRuntime();
		const handler = buildGenerateMediaHandler();
		const result = await handler(runtime, makeMessage("   "));
		expect(result.success).toBe(false);
		expect(result.data?.computerUseAction).toBe("GENERATE_MEDIA_INVALID");
		expect(useModel).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Validator + action wiring
// ---------------------------------------------------------------------------

describe("GENERATE_MEDIA — action wiring", () => {
	it("exposes the canonical name and the expected similes", () => {
		expect(generateMediaAction.name).toBe("GENERATE_MEDIA");
		expect(generateMediaAction.similes).toEqual(
			expect.arrayContaining([
				"DRAW_IMAGE",
				"CREATE_IMAGE",
				"SPEAK",
				"TEXT_TO_SPEECH",
				"GENERATE_AUDIO",
				"GENERATE_VIDEO",
			]),
		);
		expect(generateMediaAction.examples).toBeDefined();
		expect((generateMediaAction.examples ?? []).length).toBeGreaterThanOrEqual(4);
	});

	it("validate() returns true for non-empty messages and false otherwise", async () => {
		const { runtime } = makeRuntime();
		await expect(
			generateMediaAction.validate(runtime, makeMessage("draw something")),
		).resolves.toBe(true);
		await expect(
			generateMediaAction.validate(runtime, makeMessage("   ")),
		).resolves.toBe(false);
	});
});
