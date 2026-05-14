import {
	type GenerateTextParams,
	type IAgentRuntime,
	type ImageDescriptionParams,
	type ImageDescriptionResult,
	type ImageGenerationParams,
	type ImageGenerationResult,
	logger,
	ModelType,
	type Plugin,
	type TextEmbeddingParams,
	type TextToSpeechParams,
	type TranscriptionParams,
} from "@elizaos/core";

import { generateMediaAction } from "./actions/generate-media.js";

export const LOCAL_INFERENCE_PROVIDER_ID = "eliza-local-inference";
export const LOCAL_INFERENCE_PRIORITY = 0;

export const LOCAL_INFERENCE_TEXT_MODEL_TYPES = [
	ModelType.TEXT_SMALL,
	ModelType.TEXT_LARGE,
] as const;

export const LOCAL_INFERENCE_MODEL_TYPES = [
	...LOCAL_INFERENCE_TEXT_MODEL_TYPES,
	ModelType.TEXT_EMBEDDING,
	ModelType.IMAGE,
	ModelType.IMAGE_DESCRIPTION,
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
	topP?: number;
	signal?: AbortSignal;
	onTextChunk?: (chunk: string) => void | Promise<void>;
}

interface LocalInferenceEmbedResult {
	embedding: number[];
}

interface LocalInferenceTextToSpeechService {
	synthesizeSpeech?: (
		text: string,
		signal?: AbortSignal,
	) => Promise<Uint8Array | ArrayBuffer | Buffer>;
	textToSpeech?: (args: {
		text: string;
		signal?: AbortSignal;
	}) => Promise<Uint8Array | ArrayBuffer | Buffer>;
}

interface LocalInferenceTranscriptionService {
	transcribe?: (params: unknown) => Promise<string | { text?: string }>;
	transcribePcm?: (
		params: {
			pcm: Float32Array;
			sampleRate: number;
			signal?: AbortSignal;
		},
		signal?: AbortSignal,
	) => Promise<string | { text?: string }>;
}

/**
 * Optional arbiter accessor. When the local-inference plugin's runtime
 * service registers a MemoryArbiter (WS1) on the IAgentRuntime, this
 * field returns it. Cross-plugin consumers (plugin-vision, plugin-image-gen,
 * plugin-aosp-local-inference) call `service.getMemoryArbiter()` to
 * register their capability handlers and request model swaps without
 * knowing which backend is loaded.
 *
 * The concrete return type is intentionally `unknown` here to keep this
 * provider file free of a hard dependency on `./services/memory-arbiter`;
 * consumers should import the `MemoryArbiter` type from
 * `@elizaos/plugin-local-inference/services` and cast.
 */
interface LocalInferenceArbiterAccessor {
	getMemoryArbiter?: () => unknown;
}

interface LocalInferenceRuntimeService
	extends LocalInferenceTextToSpeechService,
		LocalInferenceTranscriptionService,
		LocalInferenceArbiterAccessor {
	generate?: (args: LocalInferenceGenerateArgs) => Promise<string>;
	embed?: (args: {
		input: string;
	}) => Promise<number[] | LocalInferenceEmbedResult>;
	describeImage?: (
		params: ImageDescriptionParams | string,
	) => Promise<ImageDescriptionResult | string>;
	imageDescription?: (
		params: ImageDescriptionParams | string,
	) => Promise<ImageDescriptionResult | string>;
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

type MessageLike = {
	role?: unknown;
	content?: unknown;
};

type PromptSegmentLike = {
	content?: unknown;
};

function renderPromptContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => {
				if (typeof part === "string") return part;
				if (
					part &&
					typeof part === "object" &&
					typeof (part as { text?: unknown }).text === "string"
				) {
					return (part as { text: string }).text;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}
	return "";
}

function promptFromMessages(messages: readonly MessageLike[]): string {
	return messages
		.map((message) => {
			const content = renderPromptContent(message.content);
			if (!content) return "";
			const role =
				typeof message.role === "string" && message.role.trim()
					? message.role.trim()
					: "message";
			return `${role}:\n${content}`;
		})
		.filter(Boolean)
		.join("\n\n");
}

function promptFromParams(params: GenerateTextParams): string {
	const record = params as GenerateTextParams & {
		messages?: readonly MessageLike[];
		promptSegments?: readonly PromptSegmentLike[];
	};
	const prompt =
		typeof params.prompt === "string" && params.prompt.length > 0
			? params.prompt
			: Array.isArray(record.promptSegments) && record.promptSegments.length > 0
				? record.promptSegments
						.map((segment) => renderPromptContent(segment.content))
						.join("")
				: Array.isArray(record.messages) && record.messages.length > 0
					? promptFromMessages(record.messages)
					: "";
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
		topP: params.topP,
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

function extractSpeechSignal(
	params: TextToSpeechParams | string,
): AbortSignal | undefined {
	return typeof params === "object" && params !== null
		? params.signal
		: undefined;
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
): { pcm: Float32Array; sampleRate: number; signal?: AbortSignal } {
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
		signal?: AbortSignal;
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
	return record.signal
		? { pcm: record.pcm, sampleRate, signal: record.signal }
		: { pcm: record.pcm, sampleRate };
}

function extractTranscriptionSignal(params: unknown): AbortSignal | undefined {
	return typeof params === "object" && params !== null
		? (params as { signal?: AbortSignal }).signal
		: undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	throw signal.reason instanceof Error
		? signal.reason
		: new DOMException("Aborted", "AbortError");
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

function normalizeImageDescription(
	result: ImageDescriptionResult | string,
): ImageDescriptionResult {
	if (typeof result === "string") {
		const description = ensureNonEmptyText(ModelType.IMAGE_DESCRIPTION, result);
		return {
			title: description.split(/[.!?]/, 1)[0]?.trim() || "Image",
			description,
		};
	}
	if (
		result &&
		typeof result === "object" &&
		typeof result.title === "string" &&
		typeof result.description === "string"
	) {
		return {
			title: ensureNonEmptyText(ModelType.IMAGE_DESCRIPTION, result.title),
			description: ensureNonEmptyText(
				ModelType.IMAGE_DESCRIPTION,
				result.description,
			),
		};
	}
	throw unavailable(
		ModelType.IMAGE_DESCRIPTION,
		"invalid_output",
		"[local-inference] IMAGE_DESCRIPTION backend returned an invalid description",
	);
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
		const service = serviceFromRuntime(runtime);
		if (!service) {
			// Fail-soft: when no local backend is loaded (no Eliza-1 bundle yet,
			// running cloud-only, etc.), return a zero-vector so the agent
			// bootstrap and memory pipeline can complete. Semantic search /
			// RAG will return matches based on this all-zero vector (i.e.
			// effectively degraded ordering), but the runtime stays online
			// instead of crashing on every memory write. Surface a one-time
			// warning so operators know to install a backend or wire a cloud
			// embedding provider.
			if (!emitZeroVectorWarning.warned) {
				emitZeroVectorWarning.warned = true;
				logger.warn(
					"[local-inference] TEXT_EMBEDDING requested with no active Eliza-1 backend — returning zero-vectors so the runtime can boot. To restore semantic search install/activate an Eliza-1 bundle, set ELIZAOS_CLOUD_USE_EMBEDDINGS=1 with a Cloud login, or set ELIZA_DISABLE_LOCAL_EMBEDDINGS=true to stop auto-loading this plugin.",
				);
			}
			return new Array(LOCAL_EMBEDDING_FALLBACK_DIMS).fill(0);
		}
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

// Dimensions match `bundles/0_8b/text/eliza-1-0_8b-32k.gguf` (and most current
// embedding models we ship). When operators wire a different-dimension model
// later, the agent re-indexes anyway, so this constant is for the boot path
// only — never persisted as real data.
const LOCAL_EMBEDDING_FALLBACK_DIMS = 1024;

// Module-level flag to ensure the warning fires once per process, not per call.
const emitZeroVectorWarning: { warned: boolean } = { warned: false };

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
		const signal = extractSpeechSignal(params);
		if (typeof service.synthesizeSpeech === "function") {
			return normalizeAudioBytes(await service.synthesizeSpeech(text, signal));
		}
		if (typeof service.textToSpeech === "function") {
			return normalizeAudioBytes(
				await service.textToSpeech({ text, ...(signal ? { signal } : {}) }),
			);
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
		const signal = extractTranscriptionSignal(params);
		throwIfAborted(signal);
		if (typeof service.transcribe === "function") {
			const transcript = normalizeTranscript(await service.transcribe(params));
			throwIfAborted(signal);
			return transcript;
		}
		if (typeof service.transcribePcm === "function") {
			const pcmParams = extractPcmTranscriptionParams(params);
			const transcript = normalizeTranscript(
				await (signal
					? service.transcribePcm(pcmParams, signal)
					: service.transcribePcm(pcmParams)),
			);
			throwIfAborted(signal);
			return transcript;
		}
		throw unavailable(
			ModelType.TRANSCRIPTION,
			"capability_unavailable",
			"[local-inference] Active local backend does not implement TRANSCRIPTION",
		);
	};
}

/**
 * Arbiter accessor shape used by the IMAGE_DESCRIPTION handler. Two
 * call paths converge here:
 *
 *   (a) The WS2 arbiter path. When the loader service exposes
 *       `getMemoryArbiter()` AND that arbiter has the `vision-describe`
 *       capability registered, IMAGE_DESCRIPTION dispatches through
 *       `arbiter.requestVisionDescribe(...)`.
 *
 *   (b) Legacy `service.describeImage(...)` / `service.imageDescription`.
 *       Pre-WS2 callers (the AOSP bootstrap, Florence-2 LocalAIManager)
 *       still hit this fallback.
 */
interface ArbiterLike {
	hasCapability?: (capability: string) => boolean;
	requestVisionDescribe?: <Req, Res>(req: {
		modelKey: string;
		payload: Req;
	}) => Promise<Res>;
	requestImageGen?: <Req, Res>(req: {
		modelKey: string;
		payload: Req;
	}) => Promise<Res>;
}

function tryGetArbiter(
	service: LocalInferenceRuntimeService | null,
): ArbiterLike | null {
	if (!service?.getMemoryArbiter) return null;
	const arbiter = service.getMemoryArbiter();
	if (!arbiter || typeof arbiter !== "object") return null;
	const cand = arbiter as ArbiterLike;
	if (
		typeof cand.hasCapability === "function" &&
		typeof cand.requestVisionDescribe === "function" &&
		cand.hasCapability("vision-describe")
	) {
		return cand;
	}
	return null;
}

function tryGetImageGenArbiter(
	service: LocalInferenceRuntimeService | null,
): ArbiterLike | null {
	if (!service?.getMemoryArbiter) return null;
	const arbiter = service.getMemoryArbiter();
	if (!arbiter || typeof arbiter !== "object") return null;
	const cand = arbiter as ArbiterLike;
	if (
		typeof cand.hasCapability === "function" &&
		typeof cand.requestImageGen === "function" &&
		cand.hasCapability("image-gen")
	) {
		return cand;
	}
	return null;
}

function paramsToVisionRequest(params: ImageDescriptionParams | string): {
	image: { kind: "dataUrl"; dataUrl: string } | { kind: "url"; url: string };
	prompt?: string;
} {
	const url = typeof params === "string" ? params : params.imageUrl;
	if (typeof url !== "string" || !url) {
		throw unavailable(
			ModelType.IMAGE_DESCRIPTION,
			"invalid_input",
			"[local-inference] IMAGE_DESCRIPTION requires a non-empty imageUrl",
		);
	}
	const prompt = typeof params === "object" ? params.prompt : undefined;
	if (url.startsWith("data:")) {
		return {
			image: { kind: "dataUrl", dataUrl: url },
			prompt,
		};
	}
	return {
		image: { kind: "url", url },
		prompt,
	};
}

/**
 * Runtime setting marker that plugin-vision's `hasEliza1VisionHandler`
 * polls. Setting this to `"1"` makes VisionService prefer the eliza-1
 * IMAGE_DESCRIPTION handler over local Florence-2. We set it the first
 * time the handler runs against an arbiter that has the
 * `vision-describe` capability registered, so the marker reflects
 * actual capability rather than plugin presence.
 */
const ELIZA1_VISION_MARKER = "ELIZA1_VISION_HANDLER_PRESENT";

function markEliza1VisionHandlerPresent(runtime: IAgentRuntime): void {
	const r = runtime as IAgentRuntime & {
		setSetting?: (key: string, value: unknown) => void;
		getSetting?: (key: string) => unknown;
	};
	if (typeof r.setSetting !== "function") return;
	if (typeof r.getSetting === "function") {
		const existing = r.getSetting(ELIZA1_VISION_MARKER);
		if (existing === "1" || existing === true) return;
	}
	try {
		r.setSetting(ELIZA1_VISION_MARKER, "1");
	} catch {
		// Some test runtimes don't accept setSetting at runtime — non-fatal.
	}
}

function createImageDescriptionHandler() {
	return async (
		runtime: IAgentRuntime,
		params: ImageDescriptionParams | string,
	): Promise<ImageDescriptionResult> => {
		const service = requireService(runtime, ModelType.IMAGE_DESCRIPTION);
		const arbiter = tryGetArbiter(service);
		if (arbiter?.requestVisionDescribe) {
			// WS2 path. The arbiter owns the model handle and the projector
			// cache; we forward the request and let it dispatch.
			markEliza1VisionHandlerPresent(runtime);
			const modelKeyCandidate =
				typeof params === "object"
					? (params as unknown as { modelKey?: unknown }).modelKey
					: undefined;
			const modelKey =
				typeof modelKeyCandidate === "string" && modelKeyCandidate
					? modelKeyCandidate
					: "qwen3-vl";
			const request = paramsToVisionRequest(params);
			const result = await arbiter.requestVisionDescribe<
				typeof request,
				ImageDescriptionResult | string
			>({ modelKey, payload: request });
			return normalizeImageDescription(result);
		}
		if (typeof service.describeImage === "function") {
			return normalizeImageDescription(await service.describeImage(params));
		}
		if (typeof service.imageDescription === "function") {
			return normalizeImageDescription(await service.imageDescription(params));
		}
		throw unavailable(
			ModelType.IMAGE_DESCRIPTION,
			"capability_unavailable",
			"[local-inference] Active local backend does not implement IMAGE_DESCRIPTION",
		);
	};
}

/**
 * Image-gen request shape the WS3 arbiter capability accepts. Mirrors
 * `ImageGenRequest` from `./services/imagegen/types` without importing
 * the full module here — we want this provider file to stay free of a
 * hard dependency on the imagegen subpackage so the type surface
 * doesn't reach across plugins.
 */
interface ProviderImageGenRequest {
	prompt: string;
	negativePrompt?: string;
	width?: number;
	height?: number;
	steps?: number;
	guidanceScale?: number;
	seed?: number;
	scheduler?: string;
	signal?: AbortSignal;
}

interface ProviderImageGenResult {
	image: Uint8Array;
	mime: "image/png" | "image/jpeg";
	seed: number;
	metadata: {
		model: string;
		prompt: string;
		steps: number;
		guidanceScale: number;
		inferenceTimeMs: number;
	};
}

function paramsToImageGenRequest(
	params: ImageGenerationParams,
): ProviderImageGenRequest {
	if (typeof params?.prompt !== "string" || !params.prompt.trim()) {
		throw unavailable(
			ModelType.IMAGE,
			"invalid_input",
			"[local-inference] IMAGE requires a non-empty prompt",
		);
	}
	const out: ProviderImageGenRequest = { prompt: params.prompt };
	if (typeof params.size === "string" && /^\d+x\d+$/i.test(params.size)) {
		const [w, h] = params.size
			.toLowerCase()
			.split("x")
			.map((n) => Number(n));
		if (Number.isFinite(w) && w > 0) out.width = w;
		if (Number.isFinite(h) && h > 0) out.height = h;
	}
	// Forward optional extended knobs when callers pass them through
	// the `ImageGenerationParams` extension fields. We intentionally
	// don't enrich `ImageGenerationParams` in @elizaos/core for this —
	// see "Hand-off" in the WS3 report.
	const extended = params as ImageGenerationParams & {
		negativePrompt?: unknown;
		steps?: unknown;
		guidanceScale?: unknown;
		seed?: unknown;
		scheduler?: unknown;
		signal?: unknown;
	};
	if (typeof extended.negativePrompt === "string") {
		out.negativePrompt = extended.negativePrompt;
	}
	if (typeof extended.steps === "number" && extended.steps > 0) {
		out.steps = Math.floor(extended.steps);
	}
	if (
		typeof extended.guidanceScale === "number" &&
		extended.guidanceScale >= 0
	) {
		out.guidanceScale = extended.guidanceScale;
	}
	if (typeof extended.seed === "number" && Number.isFinite(extended.seed)) {
		out.seed = Math.floor(extended.seed);
	}
	if (typeof extended.scheduler === "string") {
		out.scheduler = extended.scheduler;
	}
	if (extended.signal instanceof AbortSignal) {
		out.signal = extended.signal;
	}
	return out;
}

function imageGenResultToUrls(
	result: ProviderImageGenResult,
): ImageGenerationResult[] {
	if (!(result?.image instanceof Uint8Array) || result.image.length === 0) {
		throw unavailable(
			ModelType.IMAGE,
			"invalid_output",
			"[local-inference] IMAGE backend returned an empty image buffer",
		);
	}
	const mime = result.mime === "image/jpeg" ? "image/jpeg" : "image/png";
	const base64 = Buffer.from(result.image).toString("base64");
	return [{ url: `data:${mime};base64,${base64}` }];
}

function createImageGenerationHandler() {
	return async (
		runtime: IAgentRuntime,
		params: ImageGenerationParams,
	): Promise<ImageGenerationResult[]> => {
		const service = requireService(runtime, ModelType.IMAGE);
		const arbiter = tryGetImageGenArbiter(service);
		if (!arbiter?.requestImageGen) {
			throw unavailable(
				ModelType.IMAGE,
				"capability_unavailable",
				"[local-inference] IMAGE generation requires the WS3 arbiter image-gen capability. Register it via createImageGenCapabilityRegistration at plugin init.",
			);
		}
		const request = paramsToImageGenRequest(params);
		// The local-inference IMAGE handler only ever returns a single
		// image — local diffusion runtimes serialize batch-1 by default,
		// and an N>1 request would just be N back-to-back generates. We
		// honour `params.count` by looping the request rather than
		// pretending the backend supports batched output.
		const count = Math.max(1, Math.min(8, params.count ?? 1));
		// Resolve modelKey from the active tier the loader knows about.
		// We prefer the optional `modelKey` extension; otherwise the
		// runtime's active tier from `service.activeTier` / the
		// `LOCAL_INFERENCE_ACTIVE_TIER` setting; otherwise the safe
		// small-tier default. Callers that want to pin a specific
		// diffusion model pass `modelKey` through the params extension.
		const modelKeyCandidate = (
			params as ImageGenerationParams & { modelKey?: unknown }
		).modelKey;
		const modelKey =
			typeof modelKeyCandidate === "string" && modelKeyCandidate
				? modelKeyCandidate
				: resolveImageGenModelKeyFromRuntime(runtime);

		const results: ImageGenerationResult[] = [];
		for (let i = 0; i < count; i += 1) {
			const seeded: ProviderImageGenRequest =
				typeof request.seed === "number" && i > 0
					? { ...request, seed: request.seed + i }
					: request;
			const result = await arbiter.requestImageGen<
				ProviderImageGenRequest,
				ProviderImageGenResult
			>({ modelKey, payload: seeded });
			results.push(...imageGenResultToUrls(result));
		}
		return results;
	};
}

/**
 * Resolve the active tier-bound image-gen model id without importing
 * the imagegen subpackage. We look at:
 *
 *   1. `runtime.getSetting("LOCAL_INFERENCE_IMAGE_MODEL_KEY")` — explicit pin.
 *   2. `runtime.getSetting("LOCAL_INFERENCE_ACTIVE_TIER")` mapped through the
 *      same tier → default-model map that lives in `backend-selector.ts`.
 *   3. Fall back to the small-tier default (`imagegen-sd-1_5-q5_0`).
 */
function resolveImageGenModelKeyFromRuntime(runtime: IAgentRuntime): string {
	const r = runtime as IAgentRuntime & {
		getSetting?: (key: string) => unknown;
	};
	const pinned = r.getSetting?.("LOCAL_INFERENCE_IMAGE_MODEL_KEY");
	if (typeof pinned === "string" && pinned.trim()) return pinned.trim();
	const tier = r.getSetting?.("LOCAL_INFERENCE_ACTIVE_TIER");
	if (typeof tier === "string" && tier.trim()) {
		const mapped = TIER_TO_DEFAULT_IMAGE_MODEL_KEY[tier.trim()];
		if (mapped) return mapped;
	}
	return "imagegen-sd-1_5-q5_0";
}

/**
 * Inlined tier → default image-gen model id map. Duplicates the
 * `TIER_TO_DEFAULT_IMAGE_MODEL` entries in `backend-selector.ts` —
 * provider.ts intentionally avoids importing the imagegen subpackage
 * so the unified provider stays loadable on runtimes that don't ship
 * the WS3 capability. The two maps are kept in sync by the WS3
 * routing test (`imagegen-routing.test.ts`).
 */
const TIER_TO_DEFAULT_IMAGE_MODEL_KEY: Readonly<Record<string, string>> = {
	"eliza-1-0_8b": "imagegen-sd-1_5-q5_0",
	"eliza-1-2b": "imagegen-sd-1_5-q5_0",
	"eliza-1-4b": "imagegen-sd-1_5-q5_0",
	"eliza-1-9b": "imagegen-z-image-turbo-q4_k_m",
	"eliza-1-27b": "imagegen-z-image-turbo-q4_k_m",
	"eliza-1-27b-256k": "imagegen-z-image-turbo-q4_k_m",
	"eliza-1-27b-1m": "imagegen-z-image-turbo-q4_k_m",
};

export function createLocalInferenceModelHandlers(): NonNullable<
	Plugin["models"]
> {
	return {
		[ModelType.TEXT_SMALL]: createTextHandler(ModelType.TEXT_SMALL),
		[ModelType.TEXT_LARGE]: createTextHandler(ModelType.TEXT_LARGE),
		[ModelType.TEXT_EMBEDDING]: createEmbeddingHandler(),
		[ModelType.IMAGE]: createImageGenerationHandler(),
		[ModelType.IMAGE_DESCRIPTION]: createImageDescriptionHandler(),
		[ModelType.TEXT_TO_SPEECH]: createTextToSpeechHandler(),
		[ModelType.TRANSCRIPTION]: createTranscriptionHandler(),
	};
}

export const localInferencePlugin: Plugin = {
	name: LOCAL_INFERENCE_PROVIDER_ID,
	description:
		"Unified Eliza-1 local provider for text, embeddings, text-to-speech, and transcription.",
	priority: LOCAL_INFERENCE_PRIORITY,
	actions: [generateMediaAction],
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
				imageDescription:
					typeof service.describeImage === "function" ||
					typeof service.imageDescription === "function",
				transcription:
					typeof service.transcribe === "function" ||
					typeof service.transcribePcm === "function",
			},
			"[local-inference] Unified provider connected to runtime backend service",
		);
	},
};

export default localInferencePlugin;
