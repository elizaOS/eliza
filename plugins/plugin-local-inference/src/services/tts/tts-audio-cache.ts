/**
 * Content-hashed cache for synthesized TTS audio. WS5 capability-level
 * cache that sits between the WS1 `MemoryArbiter` and the concrete TTS
 * backend (OmniVoice / Kokoro / fake).
 *
 * Cache namespace: `tts-audio`.
 *
 * Why a capability-level cache (in addition to the existing
 * `wrap-with-first-line-cache.ts`):
 *
 *   - `wrap-with-first-line-cache.ts` is a *first-sentence* cache. It
 *     accelerates the audible TTFA on the planner's typical "short
 *     acknowledgement" leading sentence. It's keyed on `(provider,
 *     voiceId, voiceRevision, codec, voiceSettingsFingerprint,
 *     normalizedFirstSentence)`.
 *
 *   - This cache is a *full-utterance* cache. It accelerates repeated
 *     synthesis of identical inputs across turns (system prompts, idle
 *     fillers, the user replaying a previously-spoken sentence). It's
 *     keyed on `sha256(provider || model || voice || text)`. Hits short-
 *     circuit `backend.synthesize` entirely; the arbiter returns the
 *     cached bytes and records `metadata.cacheHit = true`.
 *
 * The two layers are independent. A request can hit the first-line cache,
 * a partially-matching prefix can hit this cache, both can miss — and the
 * keying spaces don't collide because the first-line cache keys on the
 * *first sentence's* normalized text, while this one keys on the full
 * text. Wire both at boot for maximum hit rate.
 *
 * Contract:
 *   - Caller computes a stable hash from a deterministic key (the request
 *     plus the active model). The hash is the cache key.
 *   - Caller pairs the hash with the synthesized bytes AND the
 *     `(mime, sampleRate, voice, model)` quadruple so a reader can
 *     reproduce a full `TtsResult` on hit.
 *   - `get(hash)` returns `null` on miss or expiry, the entry on hit. A
 *     hit also "touches" the entry to keep it warm under LRU.
 *   - `set(hash, entry, ttlMs?)` inserts with a TTL (default 10 min);
 *     if the LRU is full, the coldest entry is evicted.
 */

import { createHash } from "node:crypto";
import type { TtsMimeType } from "./types";

interface CacheEntry {
	audio: Uint8Array;
	mime: TtsMimeType;
	sampleRate: number;
	voice: string;
	model: string;
	expiresAtMs: number;
}

export interface TtsAudioEntry {
	audio: Uint8Array;
	mime: TtsMimeType;
	sampleRate: number;
	voice: string;
	model: string;
	/** True when this entry is still within its TTL. */
	live: boolean;
}

export interface TtsAudioCacheConfig {
	/** Max entries retained. LRU evicts beyond this. Default 64. */
	maxEntries: number;
	/** Default TTL when `set()` is called without one. Default 10 min. */
	defaultTtlMs: number;
	/** Optional max total bytes; an LRU sweep enforces this on insert. Default 64 MB. */
	maxBytes: number;
}

const DEFAULTS: TtsAudioCacheConfig = {
	maxEntries: 64,
	defaultTtlMs: 10 * 60_000,
	maxBytes: 64 * 1024 * 1024,
};

/**
 * Build the canonical cache key for a TTS request + active model. The
 * fields are joined with a separator that can't appear in any of them
 * (a NUL byte) and SHA-256'd. The model id participates so a tier swap
 * doesn't yield phantom hits from a different voice family.
 */
export function hashTtsRequest(args: {
	provider: string;
	model: string;
	voice: string;
	text: string;
	speed?: number;
	sampleRate?: number;
}): string {
	const h = createHash("sha256");
	h.update(args.provider);
	h.update("\0");
	h.update(args.model);
	h.update("\0");
	h.update(args.voice);
	h.update("\0");
	h.update(args.text);
	h.update("\0");
	h.update(typeof args.speed === "number" ? String(args.speed) : "");
	h.update("\0");
	h.update(typeof args.sampleRate === "number" ? String(args.sampleRate) : "");
	return h.digest("hex");
}

export class TtsAudioCache {
	private readonly config: TtsAudioCacheConfig;
	/**
	 * `Map` preserves insertion order; we re-insert on hit to bubble
	 * entries to the back, so the first key in iteration order is the
	 * LRU candidate.
	 */
	private readonly entries = new Map<string, CacheEntry>();
	private readonly now: () => number;
	private totalBytes = 0;

	constructor(
		opts: {
			config?: Partial<TtsAudioCacheConfig>;
			now?: () => number;
		} = {},
	) {
		this.config = {
			maxEntries: Math.max(1, opts.config?.maxEntries ?? DEFAULTS.maxEntries),
			defaultTtlMs: Math.max(
				0,
				opts.config?.defaultTtlMs ?? DEFAULTS.defaultTtlMs,
			),
			maxBytes: Math.max(
				1024,
				opts.config?.maxBytes ?? DEFAULTS.maxBytes,
			),
		};
		this.now = opts.now ?? (() => Date.now());
	}

	get(hash: string): TtsAudioEntry | null {
		const found = this.entries.get(hash);
		if (!found) return null;
		const live = found.expiresAtMs > this.now();
		if (!live) {
			this.entries.delete(hash);
			this.totalBytes -= found.audio.byteLength;
			return null;
		}
		// Bubble to MRU position.
		this.entries.delete(hash);
		this.entries.set(hash, found);
		return {
			audio: found.audio,
			mime: found.mime,
			sampleRate: found.sampleRate,
			voice: found.voice,
			model: found.model,
			live: true,
		};
	}

	set(
		hash: string,
		entry: {
			audio: Uint8Array;
			mime: TtsMimeType;
			sampleRate: number;
			voice: string;
			model: string;
		},
		ttlMs?: number,
	): void {
		const ttl = typeof ttlMs === "number" ? ttlMs : this.config.defaultTtlMs;
		if (ttl <= 0) return;
		const existing = this.entries.get(hash);
		if (existing) this.totalBytes -= existing.audio.byteLength;
		const record: CacheEntry = {
			audio: entry.audio,
			mime: entry.mime,
			sampleRate: entry.sampleRate,
			voice: entry.voice,
			model: entry.model,
			expiresAtMs: this.now() + ttl,
		};
		this.entries.set(hash, record);
		this.totalBytes += entry.audio.byteLength;
		this.enforceBudget();
	}

	has(hash: string): boolean {
		const found = this.entries.get(hash);
		if (!found) return false;
		if (found.expiresAtMs <= this.now()) {
			this.entries.delete(hash);
			this.totalBytes -= found.audio.byteLength;
			return false;
		}
		return true;
	}

	purgeExpired(nowMs: number = this.now()): number {
		let removed = 0;
		for (const [key, value] of this.entries) {
			if (value.expiresAtMs <= nowMs) {
				this.entries.delete(key);
				this.totalBytes -= value.audio.byteLength;
				removed += 1;
			}
		}
		return removed;
	}

	clear(): void {
		this.entries.clear();
		this.totalBytes = 0;
	}

	size(): number {
		return this.entries.size;
	}

	bytes(): number {
		return this.totalBytes;
	}

	private enforceBudget(): void {
		while (
			this.entries.size > this.config.maxEntries ||
			this.totalBytes > this.config.maxBytes
		) {
			const oldest = this.entries.keys().next();
			if (oldest.done) break;
			const key = oldest.value;
			const removed = this.entries.get(key);
			this.entries.delete(key);
			if (removed) this.totalBytes -= removed.audio.byteLength;
		}
	}
}
