import {
	type GenerateTextParams,
	type IAgentRuntime,
	logger,
	ModelType,
	type Plugin,
	type TextEmbeddingParams,
	type TextToSpeechParams,
	type TranscriptionParams,
} from "@elizaos/core";

export const LOCAL_INFERENCE_PROVIDER_ID = "eliza-local-inference";
export const LOCAL_INFERENCE_PRIORITY = 0;

export const LOCAL_INFERENCE_TEXT_MODEL_TYPES = [
	ModelType.TEXT_SMALL,
	ModelType.TEXT_LARGE,
] as const;

export const LOCAL_INFERENCE_MODEL_TYPES = [
	...LOCAL_INFERENCE_TEXT_MODEL_TYPES,
	ModelType.TEXT_EMBEDDING,
	ModelType.TEXT_TO_SPEECH,
	ModelType.TRANSCRIPTION,
] as const;

export type LocalInferenceUnavailableReason =
	| "backend_unavailable"
	| "capability_unavailable"
	| "invalid_input"
	| "invalid_output";

export class LocalInferenceUnavailableError extends Error {
	readonly code = "LOCAL_INFERENCE_UNAVAILABLE";
	readonly provider = LOCAL_INFERENCE_PROVIDER_ID;

	constructor(
		readonly modelType: string,
		readonly reason: LocalInferenceUnavailableReason,
		message: string,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "LocalInferenceUnavailableError";
	}

	toJSON(): Record<string, string> {
		return {
			code: this.code,
			provider: this.provider,
			modelType: this.modelType,
			reason: this.reason,
			message: this.message,
		};
	}
}

export function isLocalInferenceUnavailableError(
	error: unknown,
): error is LocalInferenceUnavailableError {
	return (
		error instanceof LocalInferenceUnavailableError ||
		(typeof error === "object" &&
			error !== null &&
			(error as { code?: unknown }).code === "LOCAL_INFERENCE_UNAVAILABLE")
	);
}

interface LocalInferenceGenerateArgs {
	prompt: string;
	stopSequences?: string[];
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	onTextChunk?: (chunk: string) => void | Promise<void>;
}

interface LocalInferenceEmbedResult {
	embedding: number[];
}

interface LocalInferenceTextToSpeechService {
	synthesizeSpeech?: (
		text: string,
	) => Promise<Uint8Array | ArrayBuffer | Buffer>;
	textToSpeech?: (args: {
		text: string;
	}) => Promise<Uint8Array | ArrayBuffer | Buffer>;
}

interface LocalInferenceTranscriptionService {
	transcribe?: (params: unknown) => Promise<string | { text?: string }>;
	transcribePcm?: (params: {
		pcm: Float32Array;
		sampleRate: number;
	}) => Promise<string | { text?: string }>;
}

interface LocalInferenceRuntimeService
	extends LocalInferenceTextToSpeechService,
		LocalInferenceTranscriptionService {
	generate?: (args: LocalInferenceGenerateArgs) => Promise<string>;
	embed?: (args: {
		input: string;
	}) => Promise<number[] | LocalInferenceEmbedResult>;
}

type RuntimeWithServices = IAgentRuntime & {
	getService?: (name: string) => unknown;
};

function serviceFromRuntime(
	runtime: IAgentRuntime,
): LocalInferenceRuntimeService | null {
	const withServices = runtime as RuntimeWithServices;
	if (typeof withServices.getService !== "function") return null;

	for (const name of [
		"localInferenceLoader",
		"localInference",
		"LOCAL_INFERENCE",
	]) {
		const candidate = withServices.getService(name);
		if (candidate && typeof candidate === "object") {
			return candidate as LocalInferenceRuntimeService;
		}
	}
	return null;
}

function unavailable(
	modelType: string,
	reason: LocalInferenceUnavailableReason,
	message: string,
	cause?: unknown,
): LocalInferenceUnavailableError {
	return new LocalInferenceUnavailableError(modelType, reason, message, {
		cause,
	});
}

function requireService(
	runtime: IAgentRuntime,
	modelType: string,
): LocalInferenceRuntimeService {
	const service = serviceFromRuntime(runtime);
	if (!service) {
		throw unavailable(
			modelType,
			"backend_unavailable",
			`[local-inference] ${modelType} requires an active Eliza-1 local inference backend. Activate an Eliza-1 bundle or enable an AOSP/device local loader.`,
		);
	}
	return service;
}

function promptFromParams(params: GenerateTextParams): string {
	const prompt = params.prompt ?? "";
	if (typeof prompt !== "string" || prompt.trim().length === 0) {
		throw unavailable(
			ModelType.TEXT_SMALL,
			"invalid_input",
			"[local-inference] TEXT generation requires a non-empty prompt",
		);
	}
	return prompt;
}

function textGenerationArgsFromParams(
	params: GenerateTextParams,
): LocalInferenceGenerateArgs {
	return {
		prompt: promptFromParams(params),
		stopSequences: params.stopSequences,
		maxTokens: params.maxTokens,
		temperature: params.temperature,
		signal: params.signal,
		onTextChunk:
			(params.stream === true || params.streamStructured === true) &&
			typeof params.onStreamChunk === "function"
				? (chunk) => params.onStreamChunk?.(chunk)
				: undefined,
	};
}

function extractEmbeddingText(
	params: TextEmbeddingParams | string | null,
): string {
	if (typeof params === "string") return params;
	if (params && typeof params === "object" && typeof params.text === "string") {
		return params.text;
	}
	throw unavailable(
		ModelType.TEXT_EMBEDDING,
		"invalid_input",
		"[local-inference] TEXT_EMBEDDING requires { text } or a non-empty string; null warmup probes are not served with fake vectors",
	);
}

function extractSpeechText(params: TextToSpeechParams | string): string {
	if (typeof params === "string") return params;
	if (params && typeof params === "object" && typeof params.text === "string") {
		return params.text;
	}
	throw unavailable(
		ModelType.TEXT_TO_SPEECH,
		"invalid_input",
		"[local-inference] TEXT_TO_SPEECH requires a string or { text } input",
	);
}

function ensureNonEmptyText(modelType: string, text: string): string {
	const trimmed = text.trim();
	if (!trimmed) {
		throw unavailable(
			modelType,
			"invalid_input",
			`[local-inference] ${modelType} requires non-empty text`,
		);
	}
	return trimmed;
}

function normalizeEmbeddingResult(
	result: number[] | LocalInferenceEmbedResult,
): number[] {
	const embedding = Array.isArray(result) ? result : result.embedding;
	if (
		!Array.isArray(embedding) ||
		embedding.some((value) => typeof value !== "number")
	) {
		throw unavailable(
			ModelType.TEXT_EMBEDDING,
			"invalid_output",
			"[local-inference] TEXT_EMBEDDING backend returned an invalid embedding",
		);
	}
	return embedding;
}

function normalizeAudioBytes(
	result: Uint8Array | ArrayBuffer | Buffer,
): Uint8Array {
	if (result instanceof Uint8Array) {
		return new Uint8Array(result.buffer, result.byteOffset, result.byteLength);
	}
	if (result instanceof ArrayBuffer) {
		return new Uint8Array(result);
	}
	throw unavailable(
		ModelType.TEXT_TO_SPEECH,
		"invalid_output",
		"[local-inference] TEXT_TO_SPEECH backend returned non-audio output",
	);
}

function extractPcmTranscriptionParams(
	params: TranscriptionParams | Buffer | string | unknown,
): { pcm: Float32Array; sampleRate: number } {
	if (!params || typeof params !== "object" || params instanceof Uint8Array) {
		throw unavailable(
			ModelType.TRANSCRIPTION,
			"invalid_input",
			"[local-inference] TRANSCRIPTION requires { pcm, sampleRateHz } when only transcribePcm is available",
		);
	}
	const record = params as {
		pcm?: unknown;
		sampleRateHz?: unknown;
		sampleRate?: unknown;
	};
	if (!(record.pcm instanceof Float32Array)) {
		throw unavailable(
			ModelType.TRANSCRIPTION,
			"invalid_input",
			"[local-inference] TRANSCRIPTION requires Float32Array pcm when only transcribePcm is available",
		);
	}
	const sampleRate =
		typeof record.sampleRateHz === "number"
			? record.sampleRateHz
			: typeof record.sampleRate === "number"
				? record.sampleRate
				: 0;
	if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
		throw unavailable(
			ModelType.TRANSCRIPTION,
			"invalid_input",
			"[local-inference] TRANSCRIPTION { pcm } requires a positive sampleRateHz",
		);
	}
	return { pcm: record.pcm, sampleRate };
}

function normalizeTranscript(result: string | { text?: string }): string {
	const text = typeof result === "string" ? result : result.text;
	if (typeof text !== "string") {
		throw unavailable(
			ModelType.TRANSCRIPTION,
			"invalid_output",
			"[local-inference] TRANSCRIPTION backend returned an invalid transcript",
		);
	}
	return text;
}

function createTextHandler(modelType: string) {
	return async (
		runtime: IAgentRuntime,
		params: GenerateTextParams,
	): Promise<string> => {
		const service = requireService(runtime, modelType);
		if (typeof service.generate !== "function") {
			throw unavailable(
				modelType,
				"capability_unavailable",
				`[local-inference] Active local backend does not implement ${modelType} generation`,
			);
		}
		return service.generate(textGenerationArgsFromParams(params));
	};
}

function createEmbeddingHandler() {
	return async (
		runtime: IAgentRuntime,
		params: TextEmbeddingParams | string | null,
	): Promise<number[]> => {
		const service = requireService(runtime, ModelType.TEXT_EMBEDDING);
		if (typeof service.embed !== "function") {
			throw unavailable(
				ModelType.TEXT_EMBEDDING,
				"capability_unavailable",
				"[local-inference] Active local backend does not implement TEXT_EMBEDDING",
			);
		}
		const input = ensureNonEmptyText(
			ModelType.TEXT_EMBEDDING,
			extractEmbeddingText(params),
		);
		return normalizeEmbeddingResult(await service.embed({ input }));
	};
}

function createTextToSpeechHandler() {
	return async (
		runtime: IAgentRuntime,
		params: TextToSpeechParams | string,
	): Promise<Uint8Array> => {
		const service = requireService(runtime, ModelType.TEXT_TO_SPEECH);
		const text = ensureNonEmptyText(
			ModelType.TEXT_TO_SPEECH,
			extractSpeechText(params),
		);
		if (typeof service.synthesizeSpeech === "function") {
			return normalizeAudioBytes(await service.synthesizeSpeech(text));
		}
		if (typeof service.textToSpeech === "function") {
			return normalizeAudioBytes(await service.textToSpeech({ text }));
		}
		throw unavailable(
			ModelType.TEXT_TO_SPEECH,
			"capability_unavailable",
			"[local-inference] Active local backend does not implement TEXT_TO_SPEECH",
		);
	};
}

function createTranscriptionHandler() {
	return async (
		runtime: IAgentRuntime,
		params: TranscriptionParams | Buffer | string | unknown,
	): Promise<string> => {
		const service = requireService(runtime, ModelType.TRANSCRIPTION);
		if (typeof service.transcribe === "function") {
			return normalizeTranscript(await service.transcribe(params));
		}
		if (typeof service.transcribePcm === "function") {
			return normalizeTranscript(
				await service.transcribePcm(extractPcmTranscriptionParams(params)),
			);
		}
		throw unavailable(
			ModelType.TRANSCRIPTION,
			"capability_unavailable",
			"[local-inference] Active local backend does not implement TRANSCRIPTION",
		);
	};
}

export function createLocalInferenceModelHandlers(): NonNullable<
	Plugin["models"]
> {
	return {
		[ModelType.TEXT_SMALL]: createTextHandler(ModelType.TEXT_SMALL),
		[ModelType.TEXT_LARGE]: createTextHandler(ModelType.TEXT_LARGE),
		[ModelType.TEXT_EMBEDDING]: createEmbeddingHandler(),
		[ModelType.TEXT_TO_SPEECH]: createTextToSpeechHandler(),
		[ModelType.TRANSCRIPTION]: createTranscriptionHandler(),
	};
}

export const localInferencePlugin: Plugin = {
	name: LOCAL_INFERENCE_PROVIDER_ID,
	description:
		"Unified Eliza-1 local provider for text, embeddings, text-to-speech, and transcription.",
	priority: LOCAL_INFERENCE_PRIORITY,
	models: createLocalInferenceModelHandlers(),
	async init(_config: unknown, runtime: IAgentRuntime) {
		const service = serviceFromRuntime(runtime);
		if (!service) {
			logger.info(
				"[local-inference] Unified provider registered; no active backend service is exposed yet. Model calls will return LOCAL_INFERENCE_UNAVAILABLE until an Eliza-1 backend is activated.",
			);
			return;
		}
		logger.info(
			{
				generate: typeof service.generate === "function",
				embed: typeof service.embed === "function",
				textToSpeech:
					typeof service.synthesizeSpeech === "function" ||
					typeof service.textToSpeech === "function",
				transcription:
					typeof service.transcribe === "function" ||
					typeof service.transcribePcm === "function",
			},
			"[local-inference] Unified provider connected to runtime backend service",
		);
	},
};

export default localInferencePlugin;
