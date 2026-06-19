import { writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelType, type IAgentRuntime, logger } from "@elizaos/core";

const edgeTTSMock = vi.hoisted(() => ({
	constructors: [] as Array<Record<string, unknown>>,
	ttsPromise: vi.fn(),
}));

vi.mock("node-edge-tts", () => ({
	EdgeTTS: vi.fn().mockImplementation(function EdgeTTS(options: Record<string, unknown>) {
		edgeTTSMock.constructors.push(options);
		return {
			ttsPromise: edgeTTSMock.ttsPromise,
		};
	}),
}));

import edgeTTSPlugin, { _test, synthesizeEdgeSpeech } from "../src/index.ts";

const EDGE_ENV_KEYS = [
	"EDGE_TTS_VOICE",
	"EDGE_TTS_LANG",
	"EDGE_TTS_OUTPUT_FORMAT",
	"EDGE_TTS_RATE",
	"EDGE_TTS_PITCH",
	"EDGE_TTS_VOLUME",
	"EDGE_TTS_PROXY",
	"EDGE_TTS_TIMEOUT_MS",
] as const;

function runtimeWithSettings(settings: Record<string, string | undefined>): IAgentRuntime {
	return {
		getSetting: (key: string) => settings[key],
	} as unknown as IAgentRuntime;
}

function textToSpeech() {
	const model = edgeTTSPlugin.models?.[ModelType.TEXT_TO_SPEECH];
	if (!model) {
		throw new Error("TEXT_TO_SPEECH model missing");
	}
	return model;
}

describe("@elizaos/plugin-edge-tts", () => {
	beforeEach(() => {
		edgeTTSMock.constructors.length = 0;
		edgeTTSMock.ttsPromise.mockReset();
		edgeTTSMock.ttsPromise.mockImplementation(async (_text: string, outputPath: string) => {
			writeFileSync(outputPath, Buffer.from("audio-bytes"));
		});
	});

	afterEach(() => {
		for (const key of EDGE_ENV_KEYS) {
			delete process.env[key];
		}
		vi.mocked(logger.error).mockClear();
	});

	it("prefers runtime settings over environment settings and validates timeout config", () => {
		process.env.EDGE_TTS_VOICE = "env-voice";
		process.env.EDGE_TTS_LANG = "env-lang";
		process.env.EDGE_TTS_OUTPUT_FORMAT = "audio-env";
		process.env.EDGE_TTS_TIMEOUT_MS = "123";
		process.env.EDGE_TTS_RATE = "+5%";
		process.env.EDGE_TTS_PITCH = "+3Hz";
		process.env.EDGE_TTS_VOLUME = "-2%";
		process.env.EDGE_TTS_PROXY = "http://env-proxy.test";

		const settings = _test.getEdgeTTSSettings(
			runtimeWithSettings({
				EDGE_TTS_VOICE: "runtime-voice",
				EDGE_TTS_LANG: "runtime-lang",
				EDGE_TTS_OUTPUT_FORMAT: "audio-runtime",
				EDGE_TTS_TIMEOUT_MS: "456",
				EDGE_TTS_RATE: "-10%",
			})
		);

		expect(settings).toEqual({
			voice: "runtime-voice",
			lang: "runtime-lang",
			outputFormat: "audio-runtime",
			timeoutMs: 456,
			rate: "-10%",
			pitch: "+3Hz",
			volume: "-2%",
			proxy: "http://env-proxy.test",
		});

		expect(() =>
			_test.getEdgeTTSSettings(runtimeWithSettings({ EDGE_TTS_TIMEOUT_MS: "NaN" }))
		).toThrow("EDGE_TTS_TIMEOUT_MS must be a positive integer");
		expect(() =>
			_test.getEdgeTTSSettings(runtimeWithSettings({ EDGE_TTS_TIMEOUT_MS: "12abc" }))
		).toThrow("EDGE_TTS_TIMEOUT_MS must be a positive integer");
		expect(() =>
			_test.getEdgeTTSSettings(runtimeWithSettings({ EDGE_TTS_VOICE: " \t" }))
		).toThrow("EDGE_TTS_VOICE must be a non-empty string");
	});

	it("rejects malformed text payloads before attempting synthesis", async () => {
		const model = textToSpeech();

		await expect(model(runtimeWithSettings({}), { text: "\n\t" })).rejects.toThrow(
			"requires non-empty text"
		);
		await expect(model(runtimeWithSettings({}), "x".repeat(5001))).rejects.toThrow(
			"exceeds 5000 character limit"
		);
		await expect(model(runtimeWithSettings({}), { voice: "nova" } as never)).rejects.toThrow(
			"requires text to be a string"
		);
		await expect(model(runtimeWithSettings({}), null as never)).rejects.toThrow(
			"requires text to be a string"
		);

		expect(edgeTTSMock.ttsPromise).not.toHaveBeenCalled();
	});

	it("rejects malformed speed options instead of passing poisoned rates to the provider", async () => {
		const model = textToSpeech();

		await expect(model(runtimeWithSettings({}), { text: "hello", speed: Number.NaN })).rejects.toThrow(
			"speed must be a positive finite number"
		);
		await expect(model(runtimeWithSettings({}), { text: "hello", speed: Number.POSITIVE_INFINITY })).rejects.toThrow(
			"speed must be a positive finite number"
		);
		await expect(model(runtimeWithSettings({}), { text: "hello", speed: 0 })).rejects.toThrow(
			"speed must be a positive finite number"
		);

		expect(edgeTTSMock.ttsPromise).not.toHaveBeenCalled();
	});

	it("passes sanitized options to Edge TTS and returns the generated audio", async () => {
		const model = textToSpeech();

		const result = await model(
			runtimeWithSettings({
				EDGE_TTS_PROXY: "http://proxy.test",
				EDGE_TTS_TIMEOUT_MS: "77",
			}),
			{
				text: "  hello  ",
				voice: "NOVA",
				lang: "en-GB",
				outputFormat: "riff-24khz-16bit-mono-pcm",
				speed: 1.25,
				pitch: "+4Hz",
				volume: "-3%",
			}
		);

		expect(Buffer.from(result as Uint8Array).toString()).toBe("audio-bytes");
		expect(edgeTTSMock.constructors).toEqual([
			{
				voice: "en-US-JennyNeural",
				lang: "en-GB",
				outputFormat: "riff-24khz-16bit-mono-pcm",
				saveSubtitles: false,
				timeout: 77,
				proxy: "http://proxy.test",
				rate: "+25%",
				pitch: "+4Hz",
				volume: "-3%",
			},
		]);
		expect(edgeTTSMock.ttsPromise).toHaveBeenCalledWith(
			"hello",
			expect.stringMatching(/speech\.wav$/)
		);
	});

	it("rethrows provider failures and records a useful log message", async () => {
		edgeTTSMock.ttsPromise.mockRejectedValueOnce(new Error("upstream websocket closed"));

		await expect(textToSpeech()(runtimeWithSettings({}), "hello")).rejects.toThrow(
			"upstream websocket closed"
		);
		expect(logger.error).toHaveBeenCalledWith(
			"EdgeTTS model error: upstream websocket closed"
		);
	});

	it("does not let standalone helper overrides replace validated text", async () => {
		const result = await synthesizeEdgeSpeech("  hello  ", { text: "" } as never);

		expect(Buffer.from(result).toString()).toBe("audio-bytes");
		expect(edgeTTSMock.ttsPromise).toHaveBeenCalledWith(
			"hello",
			expect.stringMatching(/speech\.mp3$/)
		);
	});

	it("keeps compact helper coverage for voice aliases, rate conversion, and extension inference", () => {
		expect(_test.resolveVoice("ALLOY", "default-voice")).toBe("en-US-GuyNeural");
		expect(_test.resolveVoice("en-AU-NatashaNeural", "default-voice")).toBe(
			"en-AU-NatashaNeural"
		);
		expect(_test.speedToRate(0.75)).toBe("-25%");
		expect(_test.speedToRate(1.234)).toBe("+23%");
		expect(_test.inferExtension("webm-24khz-16bit-mono-opus")).toBe(".webm");
		expect(_test.inferExtension("riff-24khz-16bit-mono-pcm")).toBe(".wav");
	});
});
