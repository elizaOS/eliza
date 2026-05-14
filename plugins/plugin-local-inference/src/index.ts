import crypto from "node:crypto";
import type { IAgentRuntime } from "@elizaos/core";

// Plugin entry point — public barrel for handler dispatch, routes, runtime
// wiring, selected service helpers, error types, and plugin definition.

export {
	buildGenerateMediaHandler,
	detectMediaIntent,
	generateMediaAction,
	type MediaKind,
} from "./actions/generate-media.js";
export {
	getLocalInferenceActiveModelId,
	getLocalInferenceActiveSnapshot,
	getLocalInferenceChatStatus,
	handleLocalInferenceChatCommand,
	handleLocalInferenceRoutes,
	type LocalInferenceChatMetadata,
	type LocalInferenceChatResult,
	type LocalInferenceCommandIntent,
} from "./local-inference-routes.js";
export * from "./routes/index.js";
export * from "./runtime/index.js";
export {
	createLocalInferenceModelHandlers,
	isLocalInferenceUnavailableError,
	LOCAL_INFERENCE_MODEL_TYPES,
	LOCAL_INFERENCE_PRIORITY,
	LOCAL_INFERENCE_PROVIDER_ID,
	LOCAL_INFERENCE_TEXT_MODEL_TYPES,
	LocalInferenceUnavailableError,
	type LocalInferenceUnavailableReason,
	localInferencePlugin,
	localInferencePlugin as default,
} from "./provider.js";
export { deviceBridge } from "./services/device-bridge.js";
export { runDflashDoctor } from "./services/dflash-doctor.js";
export { LocalInferenceEngine } from "./services/engine.js";
export {
	buildVoiceLatencyDevPayload,
	voiceLatencyTracer,
} from "./services/latency-trace.js";
export { ELIZA_1_TIERS } from "./services/manifest/schema.js";
export { chunkTokens, PhraseChunker } from "./services/voice/phrase-chunker.js";
export type {
	AcceptedToken,
	Phrase,
	PhraseChunkerConfig,
} from "./services/voice/types.js";

export type TtsBytes = Uint8Array | ArrayBuffer | Buffer;
export type TtsHandlerInput = string | { text: string; [key: string]: unknown };
export type TtsHandlerOutput = TtsBytes;
export type TtsHandler = (
	runtime: IAgentRuntime,
	input: TtsHandlerInput,
) => Promise<TtsHandlerOutput>;

export interface TtsResolvedContext {
	provider: string;
	voiceId: string;
	voiceRevision: string;
	codec: "opus" | "mp3" | "wav" | "pcm_f32" | "ogg" | "flac";
	contentType: string;
	sampleRate: number;
	voiceSettingsFingerprint: string;
	bypass?: boolean;
}

export interface WrapOptions {
	cache?: unknown;
	resolveContext: (
		runtime: IAgentRuntime,
		input: TtsHandlerInput,
	) => Promise<TtsResolvedContext | null> | TtsResolvedContext | null;
	concatRemainder?: boolean;
	enableCachePopulation?: boolean;
}

export function fingerprintVoiceSettings(
	settings: Record<string, unknown> | null | undefined,
): string {
	if (!settings || Object.keys(settings).length === 0) {
		return crypto.createHash("sha256").update("{}").digest("hex");
	}
	const sorted = Object.fromEntries(
		Object.keys(settings)
			.sort()
			.map((key) => [key, settings[key]]),
	);
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(sorted))
		.digest("hex");
}

export function wrapWithFirstLineCache(
	inner: TtsHandler,
	options: WrapOptions,
): TtsHandler {
	let wrapped: TtsHandler | null = null;
	let pending: Promise<TtsHandler> | null = null;

	return async function cachedTtsHandler(runtime, input) {
		if (!wrapped) {
			pending ??= import(
				"./services/voice/wrap-with-first-line-cache.js"
			).then((module) =>
				module.wrapWithFirstLineCache(
					inner as Parameters<typeof module.wrapWithFirstLineCache>[0],
					options as Parameters<typeof module.wrapWithFirstLineCache>[1],
				),
			);
			wrapped = await pending;
		}
		return wrapped(runtime, input);
	};
}
