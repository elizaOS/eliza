/**
 * First-line LRU TTS cache (disk-tier, voice-scoped).
 *
 * The in-RAM `PhraseCache` is the hot tier (keyed on text alone, single voice
 * per scheduler). This disk-tier sits behind it and is keyed on
 *   (algoVersion, provider, voiceId, voiceRevision, sampleRate, codec,
 *    voiceSettingsFingerprint, normalizedText)
 * so the F3 bug in `.swarm/VOICE_WAVE_2.md` (Kokoro→ElevenLabs voice swap
 * replaying Kokoro audio) is impossible by construction: swapping the active
 * voice changes `voiceId` and therefore changes the cache key.
 *
 * Storage layout (anchored to `resolveStateDir()`):
 *   <stateDir>/cache/tts-first-line/
 *     ├── index.sqlite                            -- LRU manifest
 *     └── blobs/
 *         <provider>/<voiceId>/<voiceRevision>/<keyHash>.<ext>
 *
 * Index schema:
 *   See `INDEX_SCHEMA_SQL` below.
 *
 * Eviction: LRU by `last_accessed_at_ms`, bounded by a configurable byte
 * budget (default 64 MB), per-entry cap (default 256 KB), TTL (default 30 d).
 *
 * Safety rules (see R4 §6):
 *   - empty `voiceRevision` rejected at insert.
 *   - cancelled / errored synth never reaches `put`.
 *   - non-default `voiceSettingsFingerprint` produces a different key.
 *   - `realtime` / non-deterministic provider models live on a per-call
 *     bypass list (callers consult `firstLineCacheBypassFromEnv`).
 *
 * Concurrency: SQLite is opened in WAL mode for many-readers / single-writer
 * across the runtime, dashboard server, and any spawned coding-agent
 * processes that emit speech. Blob writes go through a temp file + atomic
 * rename so partials never reach the index.
 *
 * SQLite resolution mirrors `packages/app-core/src/api/training-benchmarks.ts`:
 * `node:sqlite` is a Node 22.5+ / Bun ≥1.3.13 builtin. When unavailable, the
 * cache silently no-ops (`get` returns null, `put` returns false) — the
 * caller's fallback path (synthesize fresh) still works.
 */

import crypto from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { resolveStateDir } from "@elizaos/core";
import {
	FIRST_SENTENCE_MAX_WORDS,
	FIRST_SENTENCE_SNIP_VERSION,
	type FirstSentenceSnipResult,
	firstSentenceSnip,
	wordCount,
} from "@elizaos/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Logical cache key. The on-disk filename + index row are keyed on
 * `keyHash`, computed deterministically from this record.
 */
export interface FirstLineCacheKey {
	/** Pinned to `FIRST_SENTENCE_SNIP_VERSION`; bumping it invalidates every entry. */
	readonly algoVersion: string;
	readonly provider: string;
	readonly voiceId: string;
	/** sha256 of voice pack + model file (local) or `client.voices.get`
	 * settings hash (cloud-side). MUST be non-empty. */
	readonly voiceRevision: string;
	readonly sampleRate: number;
	readonly codec: "opus" | "mp3" | "wav" | "pcm_f32" | "ogg" | "flac";
	/** sha256 of `{stability, similarityBoost, style, useSpeakerBoost, speed,
	 *  pitch, ...}` JSON normalised by `fingerprintVoiceSettings`. */
	readonly voiceSettingsFingerprint: string;
	/** Output of `normalizeForKey(snip)`. */
	readonly normalizedText: string;
}

/** Stored row + bytes. */
export interface FirstLineCacheEntry extends FirstLineCacheKey {
	/** Encoded payload bytes. */
	bytes: Uint8Array;
	/** Raw (un-normalised) snip — kept for DEBUG logs only. */
	rawText: string;
	/** Negotiated content-type, e.g. `audio/mpeg`, `audio/opus`. */
	contentType: string;
	/** Synthesized audio length, used for player buffering math. */
	durationMs: number;
	/** Unicode-aware word count over `normalizedText`. */
	wordCount: number;
	/** Epoch-ms of last access; updated on get(). */
	lastAccessedAtMs: number;
	/** Epoch-ms of original synthesis. */
	generatedAtMs: number;
	/** Diagnostic counter, incremented on every get(). */
	hitCount: number;
}

export interface FirstLineCacheOptions {
	/** Root directory; defaults to `<stateDir>/cache/tts-first-line/`. */
	rootDir?: string;
	/** Total byte budget on disk; defaults to 64 MB. */
	maxBytes?: number;
	/** Per-entry byte cap; defaults to 256 KB. */
	maxBytesPerEntry?: number;
	/** Soft TTL in days; defaults to 30. */
	ttlDays?: number;
	/** When true, get/put both no-op (used by tests + emergency kill-switch). */
	disabled?: boolean;
}

export interface PutInput extends FirstLineCacheKey {
	bytes: Uint8Array;
	rawText: string;
	contentType: string;
	durationMs: number;
	wordCount?: number;
}

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_BYTES_PER_ENTRY = 256 * 1024;
const DEFAULT_TTL_DAYS = 30;
const MS_PER_DAY = 86_400_000;

const INDEX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tts_first_line (
  key_hash              TEXT PRIMARY KEY,
  algo_version          TEXT NOT NULL,
  provider              TEXT NOT NULL,
  voice_id              TEXT NOT NULL,
  voice_revision        TEXT NOT NULL,
  sample_rate           INTEGER NOT NULL,
  codec                 TEXT NOT NULL,
  voice_settings_fp     TEXT NOT NULL,
  normalized_text       TEXT NOT NULL,
  raw_text              TEXT NOT NULL,
  content_type          TEXT NOT NULL,
  duration_ms           INTEGER NOT NULL,
  byte_size             INTEGER NOT NULL,
  word_count            INTEGER NOT NULL,
  generated_at_ms       INTEGER NOT NULL,
  last_accessed_at_ms   INTEGER NOT NULL,
  hit_count             INTEGER NOT NULL DEFAULT 0,
  blob_path             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tfl_last_accessed
  ON tts_first_line (last_accessed_at_ms);
CREATE INDEX IF NOT EXISTS ix_tfl_provider_voice
  ON tts_first_line (provider, voice_id, voice_revision);
`;

// ---------------------------------------------------------------------------
// node:sqlite lazy resolver — mirrors training-benchmarks.ts
// ---------------------------------------------------------------------------

type SqliteRow = Record<string, unknown>;
interface SqliteStatement {
	all(...params: unknown[]): SqliteRow[];
	get(...params: unknown[]): SqliteRow | undefined;
	run(...params: unknown[]): { changes: number; lastInsertRowid: number };
}
interface SqliteDatabase {
	prepare(sql: string): SqliteStatement;
	exec(sql: string): void;
	close(): void;
}
type SqliteDatabaseCtor = new (
	filename: string,
	options?: { readOnly?: boolean },
) => SqliteDatabase;

const requireFromHere = createRequire(import.meta.url);
let DatabaseSyncCached: SqliteDatabaseCtor | null | undefined;

function loadDatabaseSync(): SqliteDatabaseCtor | null {
	if (DatabaseSyncCached !== undefined) return DatabaseSyncCached;
	try {
		const mod = requireFromHere("node:sqlite") as {
			DatabaseSync?: SqliteDatabaseCtor;
		};
		DatabaseSyncCached = mod?.DatabaseSync ?? null;
	} catch {
		DatabaseSyncCached = null;
	}
	return DatabaseSyncCached;
}

// ---------------------------------------------------------------------------
// Env knobs
// ---------------------------------------------------------------------------

function parseIntEnv(name: string): number | undefined {
	const raw = process?.env?.[name];
	if (!raw) return undefined;
	const v = Number.parseInt(raw, 10);
	return Number.isFinite(v) && v > 0 ? v : undefined;
}

function envDisabled(): boolean {
	const raw = process?.env?.ELIZA_TTS_CACHE_DISABLE;
	if (!raw) return false;
	const v = raw.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes";
}

/**
 * Comma-separated provider names that bypass the cache entirely.
 * Default: empty (none).
 * Set `ELIZA_TTS_CACHE_BYPASS_PROVIDERS="omnivoice,kokoro"` to skip those.
 */
export function firstLineCacheBypassFromEnv(): ReadonlySet<string> {
	const raw = process?.env?.ELIZA_TTS_CACHE_BYPASS_PROVIDERS;
	if (!raw) return new Set();
	return new Set(
		raw
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean),
	);
}

// ---------------------------------------------------------------------------
// Key + fingerprint helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic hash of the cache key. Stable across processes.
 */
export function hashCacheKey(key: FirstLineCacheKey): string {
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

/**
 * Stable sha256 hex of an arbitrary settings object — used as
 * `voiceSettingsFingerprint`. Object keys are sorted before serialisation so
 * the order in which the caller built the object doesn't affect the hash.
 */
export function fingerprintVoiceSettings(
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
	return crypto
		.createHash("sha256")
		.update(JSON.stringify(sorted))
		.digest("hex");
}

/**
 * Compute a stable `voiceRevision` for a local voice. Hashes the contents of
 * the voice pack file + the model file. Memoised on the input paths so
 * subsequent calls are free.
 */
const voiceRevisionMemo = new Map<string, string>();
export async function computeLocalVoiceRevision(
	files: ReadonlyArray<string>,
): Promise<string> {
	const memoKey = files.slice().sort().join("|");
	const cached = voiceRevisionMemo.get(memoKey);
	if (cached) return cached;
	const hash = crypto.createHash("sha256");
	const { readFile } = await import("node:fs/promises");
	for (const file of files) {
		try {
			const buf = await readFile(file);
			hash.update(file);
			hash.update(":");
			hash.update(buf);
			hash.update("|");
		} catch {
			// If a file is missing, fold its absence into the hash so a later
			// successful read produces a different revision.
			hash.update(file);
			hash.update(":missing|");
		}
	}
	const hex = hash.digest("hex");
	voiceRevisionMemo.set(memoKey, hex);
	return hex;
}

/** Test-only — clear the voice-revision memoisation. */
export function _resetVoiceRevisionMemoForTesting(): void {
	voiceRevisionMemo.clear();
}

// ---------------------------------------------------------------------------
// FirstLineCache implementation
// ---------------------------------------------------------------------------

export interface FirstLineCacheStats {
	entries: number;
	bytes: number;
	maxBytes: number;
	dbReady: boolean;
}

const CODEC_TO_EXT: Record<FirstLineCacheKey["codec"], string> = {
	opus: "opus",
	mp3: "mp3",
	wav: "wav",
	pcm_f32: "pcm",
	ogg: "ogg",
	flac: "flac",
};

export class FirstLineCache {
	private readonly rootDir: string;
	private readonly blobsDir: string;
	private readonly indexPath: string;
	private readonly maxBytes: number;
	private readonly maxBytesPerEntry: number;
	private readonly ttlMs: number;
	private readonly disabled: boolean;
	private db: SqliteDatabase | null = null;
	private initialised = false;
	private initFailed = false;

	constructor(opts: FirstLineCacheOptions = {}) {
		this.rootDir =
			opts.rootDir ??
			process?.env?.ELIZA_TTS_CACHE_DIR ??
			path.join(resolveStateDir(), "cache", "tts-first-line");
		this.blobsDir = path.join(this.rootDir, "blobs");
		this.indexPath = path.join(this.rootDir, "index.sqlite");
		this.maxBytes =
			opts.maxBytes ?? parseIntEnv("ELIZA_TTS_CACHE_MAX_BYTES") ?? DEFAULT_MAX_BYTES;
		this.maxBytesPerEntry =
			opts.maxBytesPerEntry ??
			parseIntEnv("ELIZA_TTS_CACHE_MAX_BYTES_PER_ENTRY") ??
			DEFAULT_MAX_BYTES_PER_ENTRY;
		const ttlDays = opts.ttlDays ?? parseIntEnv("ELIZA_TTS_CACHE_TTL_DAYS") ?? DEFAULT_TTL_DAYS;
		this.ttlMs = ttlDays * MS_PER_DAY;
		this.disabled = opts.disabled ?? envDisabled();
	}

	get isEnabled(): boolean {
		return !this.disabled;
	}

	/**
	 * Lazy-init the SQLite index and blob directory. Returns `false` if
	 * sqlite is unavailable (e.g. older Bun without `node:sqlite`) — the
	 * cache then no-ops on every call.
	 */
	private ensureInit(): boolean {
		if (this.disabled) return false;
		if (this.initialised) return this.db !== null;
		if (this.initFailed) return false;

		const Ctor = loadDatabaseSync();
		if (!Ctor) {
			this.initFailed = true;
			this.initialised = true;
			return false;
		}
		try {
			mkdirSync(this.rootDir, { recursive: true });
			mkdirSync(this.blobsDir, { recursive: true });
			this.db = new Ctor(this.indexPath);
			this.db.exec("PRAGMA journal_mode = WAL;");
			this.db.exec("PRAGMA synchronous = NORMAL;");
			this.db.exec(INDEX_SCHEMA_SQL);
			this.initialised = true;
			return true;
		} catch {
			this.initFailed = true;
			this.initialised = true;
			this.db = null;
			return false;
		}
	}

	/**
	 * Look up a cached entry. Returns null on miss. Touches `lastAccessedAtMs`
	 * + `hitCount` on hit. Lazy-reads the blob bytes from disk.
	 */
	get(key: FirstLineCacheKey): FirstLineCacheEntry | null {
		if (!this.ensureInit() || !this.db) return null;
		if (!key.voiceRevision) return null;
		const keyHash = hashCacheKey(key);
		const row = this.db.prepare(`SELECT * FROM tts_first_line WHERE key_hash = ?`).get(keyHash);
		if (!row) return null;

		const blobAbs = this.resolveBlobAbs(row.blob_path as string);
		let bytes: Uint8Array;
		try {
			bytes = readFileSync(blobAbs);
		} catch {
			// Blob missing → drop the orphan row and report miss.
			this.db
				.prepare(`DELETE FROM tts_first_line WHERE key_hash = ?`)
				.run(keyHash);
			return null;
		}

		const now = Date.now();
		this.db
			.prepare(
				`UPDATE tts_first_line
				 SET last_accessed_at_ms = ?, hit_count = hit_count + 1
				 WHERE key_hash = ?`,
			)
			.run(now, keyHash);

		return {
			algoVersion: row.algo_version as string,
			provider: row.provider as string,
			voiceId: row.voice_id as string,
			voiceRevision: row.voice_revision as string,
			sampleRate: row.sample_rate as number,
			codec: row.codec as FirstLineCacheKey["codec"],
			voiceSettingsFingerprint: row.voice_settings_fp as string,
			normalizedText: row.normalized_text as string,
			rawText: row.raw_text as string,
			contentType: row.content_type as string,
			bytes,
			durationMs: row.duration_ms as number,
			wordCount: row.word_count as number,
			generatedAtMs: row.generated_at_ms as number,
			lastAccessedAtMs: now,
			hitCount: ((row.hit_count as number) ?? 0) + 1,
		};
	}

	has(key: FirstLineCacheKey): boolean {
		if (!this.ensureInit() || !this.db) return false;
		if (!key.voiceRevision) return false;
		const row = this.db
			.prepare(`SELECT 1 FROM tts_first_line WHERE key_hash = ?`)
			.get(hashCacheKey(key));
		return row !== undefined;
	}

	/**
	 * Store an entry. Returns true on success, false when rejected (bad key,
	 * over-budget per-entry, sqlite unavailable, etc.).
	 *
	 * Per R4 §6: `voiceRevision` MUST be non-empty (otherwise stale bytes
	 * could survive a voice re-publish). `bytes.length === 0` is rejected
	 * too — we don't cache empty audio (likely a cancelled synthesis).
	 */
	put(input: PutInput): boolean {
		if (!this.ensureInit() || !this.db) return false;
		if (!input.voiceRevision) return false;
		if (!input.normalizedText) return false;
		if (!input.bytes || input.bytes.length === 0) return false;
		if (input.bytes.length > this.maxBytesPerEntry) return false;
		const wc = input.wordCount ?? wordCount(input.normalizedText);
		if (wc === 0 || wc > FIRST_SENTENCE_MAX_WORDS) return false;

		const keyHash = hashCacheKey(input);
		const ext = CODEC_TO_EXT[input.codec] ?? "bin";
		const relPath = path.posix.join(
			sanitisePathSegment(input.provider),
			sanitisePathSegment(input.voiceId),
			sanitisePathSegment(input.voiceRevision),
			`${keyHash}.${ext}`,
		);
		const blobAbs = this.resolveBlobAbs(relPath);
		const blobDir = path.dirname(blobAbs);
		try {
			mkdirSync(blobDir, { recursive: true });
			const tmpAbs = `${blobAbs}.${process.pid}.${Date.now()}.tmp`;
			writeFileSync(tmpAbs, input.bytes);
			renameSync(tmpAbs, blobAbs);
		} catch {
			return false;
		}

		const now = Date.now();
		try {
			this.db
				.prepare(
					`INSERT INTO tts_first_line (
						key_hash, algo_version, provider, voice_id, voice_revision,
						sample_rate, codec, voice_settings_fp, normalized_text, raw_text,
						content_type, duration_ms, byte_size, word_count,
						generated_at_ms, last_accessed_at_ms, hit_count, blob_path
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
					ON CONFLICT(key_hash) DO UPDATE SET
						last_accessed_at_ms = excluded.last_accessed_at_ms,
						generated_at_ms     = excluded.generated_at_ms,
						byte_size           = excluded.byte_size,
						blob_path           = excluded.blob_path,
						duration_ms         = excluded.duration_ms,
						content_type        = excluded.content_type`,
				)
				.run(
					keyHash,
					input.algoVersion,
					input.provider,
					input.voiceId,
					input.voiceRevision,
					input.sampleRate,
					input.codec,
					input.voiceSettingsFingerprint,
					input.normalizedText,
					input.rawText,
					input.contentType,
					input.durationMs,
					input.bytes.length,
					wc,
					now,
					now,
					relPath,
				);
		} catch {
			// Roll back the blob if the index write fails so we don't leak files.
			try {
				unlinkSync(blobAbs);
			} catch {
				/* ignore */
			}
			return false;
		}

		this.evictOverflow();
		return true;
	}

	/**
	 * Delete one entry by key. Removes both row and blob. Idempotent.
	 */
	delete(key: FirstLineCacheKey): boolean {
		if (!this.ensureInit() || !this.db) return false;
		const keyHash = hashCacheKey(key);
		const row = this.db
			.prepare(`SELECT blob_path FROM tts_first_line WHERE key_hash = ?`)
			.get(keyHash);
		if (!row) return false;
		this.db.prepare(`DELETE FROM tts_first_line WHERE key_hash = ?`).run(keyHash);
		try {
			unlinkSync(this.resolveBlobAbs(row.blob_path as string));
		} catch {
			/* ignore */
		}
		return true;
	}

	/**
	 * Sweep entries older than the TTL. Returns the number of entries removed.
	 */
	sweep(now = Date.now()): number {
		if (!this.ensureInit() || !this.db) return 0;
		const cutoff = now - this.ttlMs;
		const rows = this.db
			.prepare(`SELECT key_hash, blob_path FROM tts_first_line WHERE last_accessed_at_ms < ?`)
			.all(cutoff);
		const del = this.db.prepare(`DELETE FROM tts_first_line WHERE key_hash = ?`);
		let count = 0;
		for (const r of rows) {
			del.run(r.key_hash as string);
			try {
				unlinkSync(this.resolveBlobAbs(r.blob_path as string));
			} catch {
				/* ignore */
			}
			count++;
		}
		return count;
	}

	stats(): FirstLineCacheStats {
		if (!this.ensureInit() || !this.db) {
			return { entries: 0, bytes: 0, maxBytes: this.maxBytes, dbReady: false };
		}
		const row = this.db
			.prepare(
				`SELECT COUNT(*) AS n, COALESCE(SUM(byte_size), 0) AS total FROM tts_first_line`,
			)
			.get();
		const entries = (row?.n as number) ?? 0;
		const bytes = (row?.total as number) ?? 0;
		return {
			entries,
			bytes,
			maxBytes: this.maxBytes,
			dbReady: true,
		};
	}

	close(): void {
		if (this.db) {
			try {
				this.db.close();
			} catch {
				/* ignore */
			}
			this.db = null;
		}
		this.initialised = false;
	}

	private evictOverflow(): void {
		if (!this.db) return;
		// Cheap path: only evict if current byte sum > budget.
		const sumRow = this.db
			.prepare(`SELECT COALESCE(SUM(byte_size), 0) AS total FROM tts_first_line`)
			.get();
		let total = (sumRow?.total as number) ?? 0;
		if (total <= this.maxBytes) return;
		const rows = this.db
			.prepare(
				`SELECT key_hash, byte_size, blob_path FROM tts_first_line
				 ORDER BY last_accessed_at_ms ASC`,
			)
			.all();
		const del = this.db.prepare(`DELETE FROM tts_first_line WHERE key_hash = ?`);
		for (const r of rows) {
			if (total <= this.maxBytes) break;
			const size = (r.byte_size as number) ?? 0;
			del.run(r.key_hash as string);
			try {
				unlinkSync(this.resolveBlobAbs(r.blob_path as string));
			} catch {
				/* ignore */
			}
			total -= size;
		}
	}

	private resolveBlobAbs(rel: string): string {
		return path.join(this.blobsDir, rel);
	}
}

// ---------------------------------------------------------------------------
// Process-wide singleton
// ---------------------------------------------------------------------------

let sharedInstance: FirstLineCache | null = null;

/**
 * Per-process singleton. Tests should construct their own `FirstLineCache`
 * pointing at a temp dir instead of using this one.
 */
export function getSharedFirstLineCache(): FirstLineCache {
	if (!sharedInstance) {
		sharedInstance = new FirstLineCache();
	}
	return sharedInstance;
}

/** Test-only — reset the process-wide singleton. */
export function _resetSharedFirstLineCacheForTesting(): void {
	if (sharedInstance) sharedInstance.close();
	sharedInstance = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitisePathSegment(s: string): string {
	// Allow [A-Za-z0-9._-]; replace anything else with `_`. Empty → `_`.
	const cleaned = s.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned.length === 0 ? "_" : cleaned;
}

// ---------------------------------------------------------------------------
// Re-exports for callers that only want the snip+key pieces
// ---------------------------------------------------------------------------

export {
	FIRST_SENTENCE_MAX_WORDS,
	FIRST_SENTENCE_SNIP_VERSION,
	type FirstSentenceSnipResult,
	firstSentenceSnip,
	wordCount,
};

