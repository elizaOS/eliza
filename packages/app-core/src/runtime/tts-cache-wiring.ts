/**
 * TTS-handler ↔ first-line-cache wiring for the app-core runtime.
 *
 * The first-line cache lives in `@elizaos/plugin-local-inference/services`
 * because it needs `node:sqlite` + the local state-dir. We do a dynamic
 * import here so this module stays browser-safe and so cores that don't
 * ship the local-inference plugin still load.
 *
 * Each TTS provider has a different shape for `voiceId`, `voiceRevision`,
 * and voice-settings fingerprint — and they get bundled lazily, so we
 * resolve the context inside the handler closure rather than at registration
 * time.
 */

import type { AgentRuntime, IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import process from "node:process";
import { FIRST_SENTENCE_SNIP_VERSION } from "@elizaos/shared";

/**
 * Loose handler shape that matches both the runtime's generic registerModel
 * signature and `@elizaos/plugin-edge-tts`'s TTS handler. The wrapper passes
 * the input through unchanged, so structural compatibility is what matters.
 */
export type EdgeTtsHandler = (
	runtime: AgentRuntime,
	input: unknown,
) => Promise<unknown>;

const EDGE_TTS_DEFAULT_VOICE = "en-US-MichelleNeural";

function readEdgeTtsSetting(
	runtime: IAgentRuntime,
	key: string,
	fallback?: string,
): string | undefined {
	const envValue =
		typeof process !== "undefined" && process?.env ? process.env[key] : undefined;
	const getSetting =
		typeof (runtime as { getSetting?: (k: string) => unknown }).getSetting === "function"
			? (runtime as { getSetting: (k: string) => unknown }).getSetting.bind(runtime)
			: undefined;
	const settingValue = getSetting ? (getSetting(key) as string | undefined) : undefined;
	return settingValue ?? envValue ?? fallback;
}

/**
 * Wrap an `@elizaos/plugin-edge-tts` `ModelType.TEXT_TO_SPEECH` handler with
 * the local first-line cache.
 *
 * Returns `null` if the cache plugin isn't available (e.g. browser bundle,
 * missing node:sqlite); callers should fall back to the unwrapped handler.
 */
export async function wrapEdgeTtsHandlerWithFirstLineCache(
	inner: EdgeTtsHandler,
): Promise<EdgeTtsHandler | null> {
	let wrapModule: typeof import("@elizaos/plugin-local-inference/services");
	try {
		wrapModule = (await import(
			"@elizaos/plugin-local-inference/services"
		)) as typeof import("@elizaos/plugin-local-inference/services");
	} catch (err) {
		logger.debug?.(
			`[tts-cache-wiring] @elizaos/plugin-local-inference/services unavailable; cache disabled: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}

	if (
		typeof wrapModule.wrapWithFirstLineCache !== "function" ||
		typeof wrapModule.fingerprintVoiceSettings !== "function"
	) {
		return null;
	}

	const { wrapWithFirstLineCache, fingerprintVoiceSettings } = wrapModule;

	const wrapped = wrapWithFirstLineCache(
		inner as unknown as Parameters<typeof wrapWithFirstLineCache>[0],
		{
			resolveContext: (runtime: IAgentRuntime, input: unknown) => {
				const requestedVoice =
					typeof input === "object" && input
						? (input as { voice?: string }).voice
						: undefined;
				const settingVoice = readEdgeTtsSetting(
					runtime,
					"EDGE_TTS_VOICE",
					EDGE_TTS_DEFAULT_VOICE,
				);
				const voiceId = requestedVoice || settingVoice || EDGE_TTS_DEFAULT_VOICE;
				const outputFormat =
					readEdgeTtsSetting(
						runtime,
						"EDGE_TTS_OUTPUT_FORMAT",
						"audio-24khz-48kbitrate-mono-mp3",
					) ?? "audio-24khz-48kbitrate-mono-mp3";

				// Edge TTS doesn't expose a stable voice revision token. Synthesize
				// one bound to the SDK package id + selected output format so that
				// a future Edge backend swap (sample rate change, codec change)
				// invalidates cached bytes. The `node-edge-tts` package version
				// isn't easily resolvable at runtime; we conservatively pin
				// `edge-tts:v1`.
				const voiceRevision = `edge-tts:v1:${outputFormat}`;

				const rate = readEdgeTtsSetting(runtime, "EDGE_TTS_RATE");
				const pitch = readEdgeTtsSetting(runtime, "EDGE_TTS_PITCH");
				const volume = readEdgeTtsSetting(runtime, "EDGE_TTS_VOLUME");
				const lang = readEdgeTtsSetting(runtime, "EDGE_TTS_LANG", "en-US");

				const voiceSettingsFingerprint = fingerprintVoiceSettings({
					rate: rate ?? null,
					pitch: pitch ?? null,
					volume: volume ?? null,
					lang: lang ?? null,
					outputFormat,
				});

				const codec = /(opus)/i.test(outputFormat)
					? ("opus" as const)
					: /(ogg|webm)/i.test(outputFormat)
						? ("ogg" as const)
						: /(wav|riff|pcm)/i.test(outputFormat)
							? ("wav" as const)
							: ("mp3" as const);

				const contentType =
					codec === "mp3"
						? "audio/mpeg"
						: codec === "opus"
							? "audio/opus"
							: codec === "ogg"
								? "audio/ogg"
								: "audio/wav";

				// Sample rate inferred from the Edge output format. Most defaults
				// expose 24 kHz; the `audio-48khz-*` variants exist but are rare.
				const sampleRate = /(48khz)/i.test(outputFormat)
					? 48000
					: /(16khz)/i.test(outputFormat)
						? 16000
						: 24000;

				return {
					provider: "edge-tts",
					voiceId,
					voiceRevision,
					codec,
					contentType,
					sampleRate,
					voiceSettingsFingerprint,
				};
			},
		},
	);

	logger.debug?.(
		`[tts-cache-wiring] edge-tts wrapped with first-line cache (algo ${FIRST_SENTENCE_SNIP_VERSION})`,
	);

	return wrapped as unknown as EdgeTtsHandler;
}
