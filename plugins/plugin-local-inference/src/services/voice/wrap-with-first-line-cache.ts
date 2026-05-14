/**
 * Wrap a TTS model handler (`ModelType.TEXT_TO_SPEECH`) with the
 * `FirstLineCache` disk-tier.
 *
 * Behaviour on a wrapped handler call:
 *   1. Snip the first sentence of the input text. Reject if > 10 words or
 *      no terminator found → defer to the inner handler unchanged.
 *   2. Build the cache key from the snip + caller-supplied
 *      `(provider, voiceId, voiceRevision, codec, voiceSettingsFingerprint)`.
 *   3. On hit: if the snip is the WHOLE input, return cached bytes. If the
 *      snip is only a prefix, return `cachedBytes ++ synthesize(remainder)`.
 *      The concat path is safe for the codecs we cache today (mp3, opus,
 *      ogg are self-framed; wav/pcm_f32 are not, and the wrapper falls
 *      through for those).
 *   4. On miss: call the inner handler with the full input, return that.
 *      In the background, call the inner handler with JUST the snip to get
 *      a cleanly-framed cache entry (no mid-stream-byte alignment hazards).
 *
 * The wrapper is provider-agnostic — `WrapOptions.resolveContext` is the
 * single seam where each TTS plugin teaches the cache its provider name +
 * voice id + revision + voice-settings fingerprint.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
	type FirstLineCache,
	type FirstLineCacheKey,
	type FirstLineCacheEntry,
	type PutInput,
	getSharedFirstLineCache,
} from "./first-line-cache";
import {
	FIRST_SENTENCE_SNIP_VERSION,
	firstSentenceSnip,
	type FirstSentenceSnipResult,
} from "@elizaos/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TtsBytes = Uint8Array | ArrayBuffer | Buffer;
export type TtsHandlerInput = string | { text: string; [k: string]: unknown };
export type TtsHandlerOutput = TtsBytes;
export type TtsHandler = (
	runtime: IAgentRuntime,
	input: TtsHandlerInput,
) => Promise<TtsHandlerOutput>;

/** Caller-supplied context resolver — provider name + voice metadata. */
export interface TtsResolvedContext {
	provider: string;
	voiceId: string;
	voiceRevision: string;
	codec: FirstLineCacheKey["codec"];
	contentType: string;
	sampleRate: number;
	voiceSettingsFingerprint: string;
	/** Optional: if true, bypass the cache entirely on this call. */
	bypass?: boolean;
}

export interface WrapOptions {
	/** Inject for tests. */
	cache?: FirstLineCache;
	/**
	 * Resolve the per-call provider/voice context. Must be cheap (typically
	 * a settings read + a small sha256). Return `null` to bypass the cache.
	 */
	resolveContext: (
		runtime: IAgentRuntime,
		input: TtsHandlerInput,
	) => Promise<TtsResolvedContext | null> | TtsResolvedContext | null;
	/**
	 * Whether to attempt to concatenate cached bytes + remainder synthesis.
	 * Defaults to true for mp3/opus/ogg, false for wav/pcm_f32 (concat would
	 * corrupt the RIFF / raw stream).
	 */
	concatRemainder?: boolean;
	/** Optional pre-resolved fingerprint of voiceSettings; rarely needed. */
	enableCachePopulation?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToUint8Array(b: TtsHandlerOutput): Uint8Array {
	if (b instanceof Uint8Array) return b;
	if (b instanceof ArrayBuffer) return new Uint8Array(b);
	// Buffer is a Uint8Array subclass so the first branch already covers it.
	return new Uint8Array(b as ArrayBufferLike);
}

function extractText(input: TtsHandlerInput): string {
	return typeof input === "string" ? input : (input.text ?? "");
}

function withText(input: TtsHandlerInput, text: string): TtsHandlerInput {
	if (typeof input === "string") return text;
	return { ...input, text };
}

function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}

const NEVER_CONCAT_CODECS: ReadonlySet<FirstLineCacheKey["codec"]> = new Set([
	"wav",
	"pcm_f32",
	"flac",
]);

function canConcat(codec: FirstLineCacheKey["codec"]): boolean {
	return !NEVER_CONCAT_CODECS.has(codec);
}

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a TTS handler with first-sentence caching. Returns a new handler with
 * the same signature.
 *
 * The wrapper is safe to apply at runtime registration time — if the cache
 * is disabled (env / no sqlite), the wrapper short-circuits to the inner
 * handler with zero overhead beyond a snip attempt.
 */
export function wrapWithFirstLineCache(
	inner: TtsHandler,
	options: WrapOptions,
): TtsHandler {
	const cache = options.cache ?? getSharedFirstLineCache();

	return async function cachedTtsHandler(
		runtime: IAgentRuntime,
		input: TtsHandlerInput,
	): Promise<TtsHandlerOutput> {
		if (!cache.isEnabled) {
			return inner(runtime, input);
		}

		const text = extractText(input);
		if (!text) return inner(runtime, input);

		const snip = firstSentenceSnip(text);
		if (!snip) return inner(runtime, input);

		const ctx = await options.resolveContext(runtime, input);
		if (!ctx || ctx.bypass) return inner(runtime, input);
		if (!ctx.voiceId || !ctx.voiceRevision) return inner(runtime, input);

		const key: FirstLineCacheKey = {
			algoVersion: FIRST_SENTENCE_SNIP_VERSION,
			provider: ctx.provider,
			voiceId: ctx.voiceId,
			voiceRevision: ctx.voiceRevision,
			sampleRate: ctx.sampleRate,
			codec: ctx.codec,
			voiceSettingsFingerprint: ctx.voiceSettingsFingerprint,
			normalizedText: snip.normalized,
		};

		const hit = cache.get(key);
		if (hit) {
			return assembleFromHit({
				hit,
				snip,
				originalText: text,
				input,
				inner,
				runtime,
				options,
				codec: ctx.codec,
			});
		}

		// MISS — synthesize fresh + populate the cache in background.
		const fullBytes = await inner(runtime, input);
		const fullU8 = bytesToUint8Array(fullBytes);

		if (options.enableCachePopulation !== false) {
			schedulePopulate({
				cache,
				inner,
				runtime,
				input,
				snip,
				key,
				ctx,
			});
		}

		return fullBytes;
	};
}

interface AssembleArgs {
	hit: FirstLineCacheEntry;
	snip: FirstSentenceSnipResult;
	originalText: string;
	input: TtsHandlerInput;
	inner: TtsHandler;
	runtime: IAgentRuntime;
	options: WrapOptions;
	codec: FirstLineCacheKey["codec"];
}

async function assembleFromHit(args: AssembleArgs): Promise<TtsHandlerOutput> {
	const { hit, snip, originalText, input, inner, runtime, options, codec } = args;
	const remainder = originalText.slice(snip.endOffset).trimStart();
	const concatEnabled = options.concatRemainder ?? canConcat(codec);

	if (!remainder) return hit.bytes;
	if (!concatEnabled) {
		// Codec we can't safely concat (wav/pcm). Fall through to full synth.
		return inner(runtime, input);
	}
	const remainderBytes = await inner(runtime, withText(input, remainder));
	return concatU8(hit.bytes, bytesToUint8Array(remainderBytes));
}

interface PopulateArgs {
	cache: FirstLineCache;
	inner: TtsHandler;
	runtime: IAgentRuntime;
	input: TtsHandlerInput;
	snip: FirstSentenceSnipResult;
	key: FirstLineCacheKey;
	ctx: TtsResolvedContext;
}

function schedulePopulate(args: PopulateArgs): void {
	// Fire-and-forget. If the dedicated synthesis fails, we leave the cache
	// empty and try again next call.
	void (async () => {
		try {
			if (args.cache.has(args.key)) return;
			const snipBytes = await args.inner(
				args.runtime,
				withText(args.input, args.snip.raw),
			);
			const u8 = bytesToUint8Array(snipBytes);
			if (u8.length === 0) return;

			const put: PutInput = {
				...args.key,
				bytes: u8,
				rawText: args.snip.raw,
				contentType: args.ctx.contentType,
				durationMs: 0,
				wordCount: args.snip.wordCount,
			};
			args.cache.put(put);
		} catch (err) {
			logger.debug?.(
				`[tts-cache] first-line populate failed for "${args.snip.normalized}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	})();
}
