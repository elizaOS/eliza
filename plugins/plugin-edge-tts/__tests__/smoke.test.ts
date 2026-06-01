import { afterEach, describe, expect, it } from "vitest";
import { ModelType, type IAgentRuntime } from "@elizaos/core";
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

describe("@elizaos/plugin-edge-tts", () => {
	afterEach(() => {
		for (const key of EDGE_ENV_KEYS) {
			delete process.env[key];
		}
	});

	it("uses defaults when no runtime or env settings are present", () => {
		const settings = _test.getEdgeTTSSettings(null);

		expect(settings).toEqual({
			voice: "en-US-MichelleNeural",
			lang: "en-US",
			outputFormat: "audio-24khz-48kbitrate-mono-mp3",
			timeoutMs: 30_000,
		});
	});

	it("prefers runtime settings over environment settings and preserves optional synthesis controls", () => {
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
	});

	it("maps OpenAI-style voice presets case-insensitively and passes Edge voice ids through", () => {
		expect(_test.resolveVoice(undefined, "default-voice")).toBe("default-voice");
		expect(_test.resolveVoice("ALLOY", "default-voice")).toBe("en-US-GuyNeural");
		expect(_test.resolveVoice("nova", "default-voice")).toBe("en-US-JennyNeural");
		expect(_test.resolveVoice("en-AU-NatashaNeural", "default-voice")).toBe(
			"en-AU-NatashaNeural"
		);
	});

	it("converts speed multipliers to Edge rate strings", () => {
		expect(_test.speedToRate(undefined)).toBeUndefined();
		expect(_test.speedToRate(1)).toBeUndefined();
		expect(_test.speedToRate(1.5)).toBe("+50%");
		expect(_test.speedToRate(0.75)).toBe("-25%");
		expect(_test.speedToRate(1.234)).toBe("+23%");
	});

	it("infers audio extensions from output formats", () => {
		expect(_test.inferExtension("audio-24khz-48kbitrate-mono-mp3")).toBe(".mp3");
		expect(_test.inferExtension("webm-24khz-16bit-mono-opus")).toBe(".webm");
		expect(_test.inferExtension("ogg-24khz-16bit-mono-opus")).toBe(".ogg");
		expect(_test.inferExtension("audio-16khz-32kbitrate-mono-opus")).toBe(".opus");
		expect(_test.inferExtension("riff-24khz-16bit-mono-pcm")).toBe(".wav");
	});

	it("auto-enables for cloud containers and enabled tts feature config only", () => {
		expect(edgeTTSPlugin.autoEnable?.shouldEnable({ ELIZA_CLOUD_PROVISIONED: "1" }, {})).toBe(
			true
		);
		expect(edgeTTSPlugin.autoEnable?.shouldEnable({}, { features: { tts: true } })).toBe(true);
		expect(edgeTTSPlugin.autoEnable?.shouldEnable({}, { features: { tts: {} } })).toBe(true);
		expect(edgeTTSPlugin.autoEnable?.shouldEnable({}, { features: { tts: { enabled: false } } })).toBe(
			false
		);
		expect(edgeTTSPlugin.autoEnable?.shouldEnable({}, { features: {} })).toBe(false);
	});

	it("rejects empty and over-limit text before attempting synthesis", async () => {
		await expect(synthesizeEdgeSpeech("   ")).rejects.toThrow("requires non-empty text");
		await expect(synthesizeEdgeSpeech("x".repeat(5001))).rejects.toThrow(
			"exceeds 5000 character limit"
		);

		const textToSpeech = edgeTTSPlugin.models?.[ModelType.TEXT_TO_SPEECH];
		expect(textToSpeech).toBeDefined();
		await expect(textToSpeech?.(runtimeWithSettings({}), { text: "\n\t" })).rejects.toThrow(
			"requires non-empty text"
		);
		await expect(textToSpeech?.(runtimeWithSettings({}), "x".repeat(5001))).rejects.toThrow(
			"exceeds 5000 character limit"
		);
	});
});
