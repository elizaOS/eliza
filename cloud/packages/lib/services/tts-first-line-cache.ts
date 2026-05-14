/**
 * Eliza Cloud first-line TTS cache.
 *
 * Mirrors the local `FirstLineCache` in
 * `plugins/plugin-local-inference/src/services/voice/first-line-cache.ts`
 * for byte-equal cache-key compatibility (`hashCacheKey`). The cloud side
 * is keyed identically:
 *   sha256(algoVersion|provider|voiceId|voiceRevision|sampleRate|codec|
 *          voiceSettingsFp|normalizedText)
 *
 * Storage is split for Cloudflare Workers:
 *   - audio bytes → R2 (the `BLOB` binding) at `tts-first-line/<provider>/
 *     <voiceId>/<voiceRevision>/<keyHash>.<ext>`.
 *   - manifest    → Postgres (`tts_first_line_cache` table).
 *
 * The cache is **shared across orgs for `scope="global"`** entries (ElevenLabs
 * default voices) and **org-scoped** (`scope="org:<orgId>"`) for custom user
 * clones tracked in `userVoicesRepository`.
 *
 * Safety rules (R4 §6):
 *   - empty `voiceRevision` rejected.
 *   - non-default `voiceSettingsFp` produces a different key (no
 *     stylised-vs-neutral bleed).
 *   - failed or cancelled synthesis MUST never call `put()`.
 *   - the `realtime` model family is on a bypass allowlist below.
 *
 * Concurrency: insert is idempotent — if two workers race, the second insert
 * `ON CONFLICT (key_hash, scope) DO UPDATE` just touches `last_accessed_at`
 * + bumps `hit_count`.
 */

import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/client";
import {
	type TtsFirstLineCacheInsert,
	type TtsFirstLineCacheRow,
	ttsFirstLineCache,
} from "@/db/schemas/tts-first-line-cache";
import { getRuntimeR2Bucket } from "@/lib/storage/r2-runtime-binding";
import { logger } from "@/lib/utils/logger";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Byte budget per scope before LRU eviction kicks in. Default 256 MB. */
const DEFAULT_MAX_BYTES_PER_SCOPE = 256 * 1024 * 1024;

/** Per-entry byte cap. Default 256 KB (≤10-word snip at mp3 128k is ~16 KB). */
const DEFAULT_MAX_BYTES_PER_ENTRY = 256 * 1024;

/** Soft TTL in days. Default 90. Entries past TTL get swept by cron. */
const DEFAULT_TTL_DAYS = 90;

/**
 * Models that intentionally produce non-deterministic output and therefore
 * MUST bypass the cache.
 */
const BYPASS_MODELS: ReadonlySet<string> = new Set([
	"eleven_flash_v2_5_realtime",
	"eleven_multilingual_v2_realtime",
]);

// ---------------------------------------------------------------------------
// Types — must mirror the local cache's `FirstLineCacheKey` exactly so the
// `hashCacheKey` output matches byte-for-byte. The local module re-exports
// from `@elizaos/shared` for the snip helper; we duplicate the key shape here
// because importing `@elizaos/plugin-local-inference` server-side is too
// heavy for a Workers bundle.
// ---------------------------------------------------------------------------

export type CloudFirstLineCacheCodec =
	| "opus"
	| "mp3"
	| "wav"
	| "pcm_f32"
	| "ogg"
	| "flac";

export interface CloudFirstLineCacheKey {
	algoVersion: string;
	provider: string;
	voiceId: string;
	voiceRevision: string;
	sampleRate: number;
	codec: CloudFirstLineCacheCodec;
	voiceSettingsFingerprint: string;
	normalizedText: string;
	/** `"global"` for default voices, `"org:<orgId>"` for custom clones. */
	scope: string;
}

export interface CloudFirstLineCacheEntry extends CloudFirstLineCacheKey {
	bytes: Uint8Array;
	rawText: string;
	contentType: string;
	durationMs: number;
	wordCount: number;
	byteSize: number;
	hitCount: number;
	blobKey: string;
}

export interface CloudFirstLineCachePutInput extends CloudFirstLineCacheKey {
	bytes: Uint8Array;
	rawText: string;
	contentType: string;
	durationMs: number;
	wordCount: number;
}

// ---------------------------------------------------------------------------
// Key + path helpers — MUST stay in sync with the local cache.
// ---------------------------------------------------------------------------

/**
 * Stable sha256 of the key fields. Byte-for-byte identical to the local
 * `hashCacheKey` (same field order, same `|` separator).
 */
export function hashCloudCacheKey(key: CloudFirstLineCacheKey): string {
	const parts = [
		key.algoVersion,
		key.provider,
		key.voiceId,
		key.voiceRevision,
		String(key.sampleRate),
		key.codec,
		key.voiceSettingsFingerprint,
		key.normalizedText,
	].join("|");
	return crypto.createHash("sha256").update(parts).digest("hex");
}

const CODEC_EXT: Record<CloudFirstLineCacheCodec, string> = {
	opus: "opus",
	mp3: "mp3",
	wav: "wav",
	pcm_f32: "pcm",
	ogg: "ogg",
	flac: "flac",
};

function sanitiseSegment(s: string): string {
	const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned.length === 0 ? "_" : cleaned;
}

function blobKeyFor(key: CloudFirstLineCacheKey, keyHash: string): string {
	const ext = CODEC_EXT[key.codec] ?? "bin";
	return [
		"tts-first-line",
		sanitiseSegment(key.provider),
		sanitiseSegment(key.voiceId),
		sanitiseSegment(key.voiceRevision),
		`${keyHash}.${ext}`,
	].join("/");
}

// ---------------------------------------------------------------------------
// Settings fingerprint — keep in sync with the local
// `fingerprintVoiceSettings`.
// ---------------------------------------------------------------------------

/**
 * Stable sha256 of a settings object. Cloud + local MUST produce the same
 * fingerprint for the same logical settings, so we sort keys and JSON-encode
 * deterministically.
 */
export function fingerprintCloudVoiceSettings(
	settings: Record<string, unknown> | null | undefined,
): string {
	if (!settings || Object.keys(settings).length === 0) {
		return crypto.createHash("sha256").update("{}").digest("hex");
	}
	const sorted = Object.fromEntries(
		Object.keys(settings)
			.sort()
			.map((k) => [k, settings[k]]),
	);
	return crypto.createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

// ---------------------------------------------------------------------------
// Bypass helpers
// ---------------------------------------------------------------------------

export function shouldBypassCloudFirstLineCache(args: {
	modelId?: string | null;
	forceBypass?: boolean;
}): boolean {
	if (args.forceBypass) return true;
	if (args.modelId && BYPASS_MODELS.has(args.modelId)) return true;
	return false;
}

// ---------------------------------------------------------------------------
// R2 read + write helpers
// ---------------------------------------------------------------------------

async function r2GetBytes(blobKey: string): Promise<Uint8Array | null> {
	const bucket = getRuntimeR2Bucket();
	if (!bucket) return null;
	try {
		const obj = await bucket.get(blobKey);
		if (!obj) return null;
		// Workers' real R2 object has both `text()` and `arrayBuffer()`.
		// Our shim type may only declare `text()` — fall back to encoding the
		// text if `arrayBuffer` is unavailable (test environments).
		if (typeof obj.arrayBuffer === "function") {
			const ab = await obj.arrayBuffer();
			return new Uint8Array(ab);
		}
		const text = await obj.text();
		return new TextEncoder().encode(text);
	} catch (err) {
		logger.warn?.(
			`[tts-first-line-cache] R2 get(${blobKey}) failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return null;
	}
}

async function r2PutBytes(
	blobKey: string,
	bytes: Uint8Array,
	contentType: string,
): Promise<boolean> {
	const bucket = getRuntimeR2Bucket();
	if (!bucket) return false;
	try {
		const ab = bytes.buffer.slice(
			bytes.byteOffset,
			bytes.byteOffset + bytes.byteLength,
		) as ArrayBuffer;
		await bucket.put(blobKey, ab, {
			httpMetadata: { contentType },
		});
		return true;
	} catch (err) {
		logger.warn?.(
			`[tts-first-line-cache] R2 put(${blobKey}) failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return false;
	}
}

// ---------------------------------------------------------------------------
// Public service
// ---------------------------------------------------------------------------

export interface CloudFirstLineCacheOptions {
	/** Total budget per scope in bytes. Default 256 MB. */
	maxBytesPerScope?: number;
	/** Per-entry cap in bytes. Default 256 KB. */
	maxBytesPerEntry?: number;
	/** Soft TTL in days. Default 90. */
	ttlDays?: number;
}

const FIRST_SENTENCE_MAX_WORDS = 10;

export class CloudFirstLineCacheService {
	private readonly maxBytesPerScope: number;
	private readonly maxBytesPerEntry: number;
	private readonly ttlDays: number;

	constructor(opts: CloudFirstLineCacheOptions = {}) {
		this.maxBytesPerScope = opts.maxBytesPerScope ?? DEFAULT_MAX_BYTES_PER_SCOPE;
		this.maxBytesPerEntry = opts.maxBytesPerEntry ?? DEFAULT_MAX_BYTES_PER_ENTRY;
		this.ttlDays = opts.ttlDays ?? DEFAULT_TTL_DAYS;
	}

	/**
	 * Look up a cache entry. Returns null on miss / R2 read failure / orphan
	 * (manifest row exists but blob is gone — row is dropped in that case).
	 *
	 * On hit, atomically bumps `hit_count` and `last_accessed_at`.
	 */
	async get(key: CloudFirstLineCacheKey): Promise<CloudFirstLineCacheEntry | null> {
		if (!key.voiceRevision) return null;
		if (!key.normalizedText) return null;
		const keyHash = hashCloudCacheKey(key);
		const [row] = (await dbRead
			.select()
			.from(ttsFirstLineCache)
			.where(
				and(
					eq(ttsFirstLineCache.keyHash, keyHash),
					eq(ttsFirstLineCache.scope, key.scope),
				),
			)
			.limit(1)) as TtsFirstLineCacheRow[];
		if (!row) return null;

		const bytes = await r2GetBytes(row.blobKey);
		if (!bytes) {
			// Orphan — drop the row so the next call will re-populate.
			await dbWrite
				.delete(ttsFirstLineCache)
				.where(eq(ttsFirstLineCache.id, row.id));
			return null;
		}

		// LRU touch + hit count. Fire-and-forget — failure here is non-fatal.
		void dbWrite
			.update(ttsFirstLineCache)
			.set({
				lastAccessedAt: new Date(),
				hitCount: row.hitCount + 1,
			})
			.where(eq(ttsFirstLineCache.id, row.id))
			.catch((err) => {
				logger.warn?.(
					`[tts-first-line-cache] failed to touch row ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
				);
			});

		return {
			...key,
			bytes,
			rawText: row.rawText,
			contentType: row.contentType,
			durationMs: row.durationMs,
			wordCount: row.wordCount,
			byteSize: row.byteSize,
			hitCount: row.hitCount + 1,
			blobKey: row.blobKey,
		};
	}

	async has(key: CloudFirstLineCacheKey): Promise<boolean> {
		if (!key.voiceRevision) return false;
		const keyHash = hashCloudCacheKey(key);
		const [row] = await dbRead
			.select({ id: ttsFirstLineCache.id })
			.from(ttsFirstLineCache)
			.where(
				and(
					eq(ttsFirstLineCache.keyHash, keyHash),
					eq(ttsFirstLineCache.scope, key.scope),
				),
			)
			.limit(1);
		return Boolean(row);
	}

	/**
	 * Store an entry. Validates per R4 §6 and idempotently upserts the
	 * manifest row.
	 */
	async put(input: CloudFirstLineCachePutInput): Promise<boolean> {
		if (!input.voiceRevision) return false;
		if (!input.normalizedText) return false;
		if (!input.bytes || input.bytes.length === 0) return false;
		if (input.bytes.length > this.maxBytesPerEntry) return false;
		if (input.wordCount === 0 || input.wordCount > FIRST_SENTENCE_MAX_WORDS) {
			return false;
		}

		const keyHash = hashCloudCacheKey(input);
		const blobKey = blobKeyFor(input, keyHash);

		const ok = await r2PutBytes(blobKey, input.bytes, input.contentType);
		if (!ok) return false;

		const insert: TtsFirstLineCacheInsert = {
			keyHash,
			scope: input.scope,
			algoVersion: input.algoVersion,
			provider: input.provider,
			voiceId: input.voiceId,
			voiceRevision: input.voiceRevision,
			sampleRate: input.sampleRate,
			codec: input.codec,
			voiceSettingsFp: input.voiceSettingsFingerprint,
			normalizedText: input.normalizedText,
			rawText: input.rawText,
			contentType: input.contentType,
			durationMs: input.durationMs,
			byteSize: input.bytes.length,
			wordCount: input.wordCount,
			blobKey,
			hitCount: 0,
		};

		try {
			// Upsert on (keyHash, scope). We rely on a unique-ish access pattern;
			// if two writers race the second one just touches the LRU columns.
			const existing = await dbRead
				.select({ id: ttsFirstLineCache.id })
				.from(ttsFirstLineCache)
				.where(
					and(
						eq(ttsFirstLineCache.keyHash, keyHash),
						eq(ttsFirstLineCache.scope, input.scope),
					),
				)
				.limit(1);
			if (existing[0]) {
				await dbWrite
					.update(ttsFirstLineCache)
					.set({
						lastAccessedAt: new Date(),
						byteSize: input.bytes.length,
						blobKey,
						contentType: input.contentType,
						durationMs: input.durationMs,
					})
					.where(eq(ttsFirstLineCache.id, existing[0].id));
			} else {
				await dbWrite.insert(ttsFirstLineCache).values(insert);
			}
		} catch (err) {
			logger.warn?.(
				`[tts-first-line-cache] manifest write failed: ${err instanceof Error ? err.message : String(err)}`,
			);
			return false;
		}

		// LRU eviction is best-effort — kicked off in the background.
		void this.maybeEvict(input.scope).catch(() => undefined);

		return true;
	}

	/**
	 * Evict oldest entries within a scope if total bytes exceed the budget.
	 * Safe to call concurrently; eviction is idempotent.
	 */
	async maybeEvict(scope: string): Promise<number> {
		const [total] = await dbRead
			.select({ total: sql<number>`COALESCE(SUM(${ttsFirstLineCache.byteSize}), 0)` })
			.from(ttsFirstLineCache)
			.where(eq(ttsFirstLineCache.scope, scope));
		const currentBytes = Number(total?.total ?? 0);
		if (currentBytes <= this.maxBytesPerScope) return 0;

		// Pull the oldest-accessed rows and remove them until we're under budget.
		const rows = await dbRead
			.select({
				id: ttsFirstLineCache.id,
				byteSize: ttsFirstLineCache.byteSize,
				blobKey: ttsFirstLineCache.blobKey,
			})
			.from(ttsFirstLineCache)
			.where(eq(ttsFirstLineCache.scope, scope))
			.orderBy(ttsFirstLineCache.lastAccessedAt);

		let removed = 0;
		let runningTotal = currentBytes;
		const bucket = getRuntimeR2Bucket();
		for (const row of rows) {
			if (runningTotal <= this.maxBytesPerScope) break;
			try {
				await dbWrite.delete(ttsFirstLineCache).where(eq(ttsFirstLineCache.id, row.id));
				if (bucket) {
					await bucket.delete(row.blobKey).catch(() => undefined);
				}
				runningTotal -= Number(row.byteSize);
				removed++;
			} catch (err) {
				logger.warn?.(
					`[tts-first-line-cache] eviction step failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		return removed;
	}
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

let serviceSingleton: CloudFirstLineCacheService | null = null;

export function getCloudFirstLineCacheService(): CloudFirstLineCacheService {
	if (!serviceSingleton) {
		serviceSingleton = new CloudFirstLineCacheService();
	}
	return serviceSingleton;
}

export function _resetCloudFirstLineCacheServiceForTesting(): void {
	serviceSingleton = null;
}
