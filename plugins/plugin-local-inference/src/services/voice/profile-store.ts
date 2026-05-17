/**
 * Content-addressed voice-profile store with hot LRU + cold disk tiers.
 *
 * Each profile is one WeSpeaker ResNet34-LM centroid plus running
 * variance (Welford), consent flags, and an entity binding. Profiles
 * are content-addressed by `sha256(centroid_bytes)` so duplicate
 * captures collapse and entity merges are safe.
 *
 * Layout under `$ELIZA_STATE_DIR/voice-profiles/`:
 *
 *   index.json                   — entityId/cluster index + LRU order
 *   profiles/vp_<sha>.json       — one record per profile
 *   audio/vp_<sha>/sample-*.wav  — optional, consent-gated
 *
 * The contract:
 *  - **Hot LRU 30** in-memory records (default `hotCacheSize`).
 *  - **Cold disk cap 200** (default `coldDiskMax`).
 *  - `beginMatch()` starts at speech-start and resolves once minSpeechMs
 *    of audio has been encoded — runs in parallel with ASR.
 *  - `refine()` uses online running-mean + Welford variance.
 *  - Profiles with a non-null `entityId` are never auto-evicted.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
	cosineSimilarity,
	DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD,
	type VoiceImprintMatch,
	type VoiceImprintProfile,
} from "./speaker-imprint";
import type { VoiceInputSource } from "./types";

/** Canonical schema version for `vp_*.json` records. */
export const VOICE_PROFILE_RECORD_SCHEMA_VERSION =
	"eliza.voice_profile_record.v1" as const;

export interface VoiceProfileConsentState {
	attributionAuthorized: boolean;
	synthesisAuthorized: boolean;
	grantedAt?: string;
	grantedBy?: string;
}

export interface VoiceProfileAudioRef {
	sampleId: string;
	wavSha256: string;
	durationMs: number;
	recordedAt: string;
	referenceText?: string;
}

export interface VoiceProfileRecord {
	schemaVersion: typeof VOICE_PROFILE_RECORD_SCHEMA_VERSION;
	profileId: string;
	embeddingModel: string;
	embeddingDim: number;
	/** L2-normalized centroid; cosine == dot. */
	centroid: number[];
	/** Welford per-dim variance accumulator (M2 / max(1, n-1)). */
	variance: number[];
	/** Welford `M2` running sum (per-dim squared diff from running mean). */
	welfordM2: number[];
	sampleCount: number;
	totalDurationMs: number;
	firstObservedAt: string;
	lastObservedAt: string;
	lastRefinedAt: string;
	entityId: string | null;
	imprintClusterId: string;
	confidence: number;
	consent: VoiceProfileConsentState;
	audioRefs?: VoiceProfileAudioRef[];
	metadata?: Record<string, unknown>;
}

export interface VoiceProfileStoreOptions {
	rootDir: string;
	hotCacheSize?: number;
	coldDiskMax?: number;
	matchThreshold?: number;
	/** Below this we open a new cluster instead of attributing. */
	unmatchedClusterThreshold?: number;
}

export interface VoiceImprintMatchHandle {
	/** Resolves once minSpeechMs of audio is encoded, or `null` if no match. */
	result: Promise<VoiceImprintMatch | null>;
	/** Synchronous polling for the latest match — null until first resolve. */
	current(): VoiceImprintMatch | null;
	cancel(): void;
}

const DEFAULT_HOT_CACHE = 30;
const DEFAULT_COLD_DISK = 200;
const DEFAULT_UNMATCHED_THRESHOLD = 0.55;

function iso(): string {
	return new Date().toISOString();
}

function sha256(buf: Buffer | Uint8Array | string): string {
	const hash = crypto.createHash("sha256");
	hash.update(buf as Buffer);
	return hash.digest("hex");
}

function centroidToBuffer(centroid: readonly number[]): Buffer {
	const arr = new Float32Array(centroid);
	return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function deriveProfileId(centroid: readonly number[]): string {
	return `vp_${sha256(centroidToBuffer(centroid)).slice(0, 32)}`;
}

interface IndexEntry {
	profileId: string;
	entityId: string | null;
	imprintClusterId: string;
	embeddingModel: string;
	embeddingDim: number;
	lastObservedAt: string;
	sampleCount: number;
	/** LRU order — higher = more recently touched. */
	lruRank: number;
}

interface IndexFile {
	version: 1;
	nextLruRank: number;
	entries: IndexEntry[];
}

const INITIAL_INDEX: IndexFile = {
	version: 1,
	nextLruRank: 1,
	entries: [],
};

/**
 * Welford online variance update. Returns the new (mean, M2, count)
 * triple so a caller can persist the M2 and derive variance lazily.
 * `prevMean` is the running mean *before* the observation; the caller
 * passes the L2-normalized embedding as the observation.
 */
export function welfordUpdate(args: {
	count: number;
	mean: readonly number[];
	m2: readonly number[];
	observation: ReadonlyArray<number>;
}): { mean: number[]; m2: number[]; count: number } {
	const n = args.count + 1;
	const dim = args.observation.length;
	if (
		(args.mean.length !== 0 && args.mean.length !== dim) ||
		(args.m2.length !== 0 && args.m2.length !== dim)
	) {
		throw new Error("[welfordUpdate] dim mismatch");
	}
	const mean =
		args.mean.length === dim ? args.mean.slice() : new Array(dim).fill(0);
	const m2 = args.m2.length === dim ? args.m2.slice() : new Array(dim).fill(0);
	for (let i = 0; i < dim; i += 1) {
		const x = args.observation[i];
		const delta = x - mean[i];
		mean[i] += delta / n;
		const delta2 = x - mean[i];
		m2[i] += delta * delta2;
	}
	return { mean, m2, count: n };
}

export function welfordVariance(
	m2: readonly number[],
	count: number,
): number[] {
	const denom = Math.max(1, count - 1);
	return m2.map((v) => v / denom);
}

/**
 * Reject an observation if its per-dim distance from the centroid is
 * more than `sigmaThreshold` standard deviations on more than half the
 * dimensions. Used to drop cough / cross-talk samples that would
 * corrupt the centroid.
 */
export function isOutlier(args: {
	centroid: readonly number[];
	variance: readonly number[];
	observation: readonly number[];
	sigmaThreshold?: number;
}): boolean {
	const sigma = args.sigmaThreshold ?? 4;
	let exceeded = 0;
	const dim = args.observation.length;
	for (let i = 0; i < dim; i += 1) {
		const v = args.variance[i] ?? 0;
		if (v <= 1e-12) continue;
		const std = Math.sqrt(v);
		const z = Math.abs(args.observation[i] - args.centroid[i]) / std;
		if (z > sigma) exceeded += 1;
	}
	return exceeded > dim / 2;
}

export class VoiceProfileStore {
	private readonly hotCacheSize: number;
	private readonly coldDiskMax: number;
	private readonly matchThreshold: number;
	private readonly unmatchedThreshold: number;
	private readonly rootDir: string;
	private readonly profilesDir: string;
	private readonly indexPath: string;
	/** Hot cache: profileId → record. Insertion order = LRU order. */
	private hot = new Map<string, VoiceProfileRecord>();
	private indexCache: IndexFile | null = null;

	constructor(options: VoiceProfileStoreOptions) {
		this.rootDir = options.rootDir;
		this.profilesDir = path.join(this.rootDir, "profiles");
		this.indexPath = path.join(this.rootDir, "index.json");
		this.hotCacheSize = Math.max(1, options.hotCacheSize ?? DEFAULT_HOT_CACHE);
		this.coldDiskMax = Math.max(
			this.hotCacheSize,
			options.coldDiskMax ?? DEFAULT_COLD_DISK,
		);
		this.matchThreshold =
			options.matchThreshold ?? DEFAULT_VOICE_IMPRINT_MATCH_THRESHOLD;
		this.unmatchedThreshold =
			options.unmatchedClusterThreshold ?? DEFAULT_UNMATCHED_THRESHOLD;
	}

	get matchThresholdValue(): number {
		return this.matchThreshold;
	}

	get unmatchedClusterThresholdValue(): number {
		return this.unmatchedThreshold;
	}

	/** Public for tests / management UI. */
	get hotCacheSizeValue(): number {
		return this.hotCacheSize;
	}

	get coldDiskMaxValue(): number {
		return this.coldDiskMax;
	}

	async init(): Promise<void> {
		await fsp.mkdir(this.profilesDir, { recursive: true });
		if (!fs.existsSync(this.indexPath)) {
			await this.writeIndex(INITIAL_INDEX);
		}
		await this.readIndex();
	}

	private async readIndex(): Promise<IndexFile> {
		if (this.indexCache) return this.indexCache;
		try {
			const raw = await fsp.readFile(this.indexPath, "utf8");
			const parsed = JSON.parse(raw) as IndexFile;
			if (!parsed.entries) parsed.entries = [];
			if (!parsed.nextLruRank) parsed.nextLruRank = 1;
			parsed.version = 1;
			this.indexCache = parsed;
			return parsed;
		} catch {
			this.indexCache = { ...INITIAL_INDEX, entries: [] };
			return this.indexCache;
		}
	}

	private async writeIndex(index: IndexFile): Promise<void> {
		this.indexCache = index;
		const tmp = `${this.indexPath}.tmp`;
		await fsp.writeFile(tmp, JSON.stringify(index, null, 2), "utf8");
		await fsp.rename(tmp, this.indexPath);
	}

	private profilePath(profileId: string): string {
		const safe = profileId.replace(/[^a-zA-Z0-9._-]/g, "_");
		return path.join(this.profilesDir, `${safe}.json`);
	}

	private async readProfileFromDisk(
		profileId: string,
	): Promise<VoiceProfileRecord | null> {
		try {
			const raw = await fsp.readFile(this.profilePath(profileId), "utf8");
			return JSON.parse(raw) as VoiceProfileRecord;
		} catch {
			return null;
		}
	}

	private async writeProfileToDisk(record: VoiceProfileRecord): Promise<void> {
		const tmp = `${this.profilePath(record.profileId)}.tmp`;
		await fsp.writeFile(tmp, JSON.stringify(record, null, 2), "utf8");
		await fsp.rename(tmp, this.profilePath(record.profileId));
	}

	/** Touch the LRU order: re-insert at the end. */
	private touchHot(record: VoiceProfileRecord): void {
		if (this.hot.has(record.profileId)) {
			this.hot.delete(record.profileId);
		}
		this.hot.set(record.profileId, record);
		while (this.hot.size > this.hotCacheSize) {
			// Evict oldest entry — still on disk, so this is just a memory drop.
			const oldest = this.hot.keys().next().value;
			if (oldest !== undefined) this.hot.delete(oldest);
			else break;
		}
	}

	private async upsertIndexEntry(record: VoiceProfileRecord): Promise<void> {
		const index = await this.readIndex();
		const lruRank = index.nextLruRank;
		index.nextLruRank = lruRank + 1;
		const existing = index.entries.findIndex(
			(e) => e.profileId === record.profileId,
		);
		const entry: IndexEntry = {
			profileId: record.profileId,
			entityId: record.entityId,
			imprintClusterId: record.imprintClusterId,
			embeddingModel: record.embeddingModel,
			embeddingDim: record.embeddingDim,
			lastObservedAt: record.lastObservedAt,
			sampleCount: record.sampleCount,
			lruRank,
		};
		if (existing >= 0) {
			index.entries[existing] = entry;
		} else {
			index.entries.push(entry);
		}
		await this.enforceColdLimit(index);
		await this.writeIndex(index);
	}

	private async enforceColdLimit(index: IndexFile): Promise<void> {
		if (index.entries.length <= this.coldDiskMax) return;
		// Eligible for eviction: no entity binding AND low confidence AND
		// few samples. Sort ascending by lruRank (oldest first) and unlink.
		const evictionCandidates = index.entries
			.filter((entry) => entry.entityId === null)
			.sort((a, b) => a.lruRank - b.lruRank);
		while (
			index.entries.length > this.coldDiskMax &&
			evictionCandidates.length > 0
		) {
			const victim = evictionCandidates.shift();
			if (!victim) break;
			const record = await this.readProfileFromDisk(victim.profileId);
			if (record && record.entityId !== null) continue;
			if (record && (record.confidence >= 0.5 || record.sampleCount >= 3)) {
				continue;
			}
			await fsp.unlink(this.profilePath(victim.profileId)).catch(() => {});
			index.entries = index.entries.filter(
				(e) => e.profileId !== victim.profileId,
			);
			this.hot.delete(victim.profileId);
		}
	}

	private async ensureLoaded(
		profileId: string,
	): Promise<VoiceProfileRecord | null> {
		const hot = this.hot.get(profileId);
		if (hot) {
			this.touchHot(hot);
			return hot;
		}
		const disk = await this.readProfileFromDisk(profileId);
		if (disk) this.touchHot(disk);
		return disk;
	}

	/** Walk profiles + return the best match above `matchThreshold` (or null). */
	async findBestMatch(args: {
		embedding: Float32Array;
		embeddingModel: string;
	}): Promise<VoiceImprintMatch | null> {
		const index = await this.readIndex();
		let best: VoiceImprintMatch | null = null;
		for (const entry of index.entries) {
			if (entry.embeddingModel !== args.embeddingModel) continue;
			if (entry.embeddingDim !== args.embedding.length) continue;
			const record = await this.ensureLoaded(entry.profileId);
			if (!record) continue;
			const similarity = cosineSimilarity(args.embedding, record.centroid);
			if (similarity < this.matchThreshold) continue;
			const confidence = Math.max(
				0,
				Math.min(
					1,
					((similarity - this.matchThreshold) /
						Math.max(0.0001, 1 - this.matchThreshold)) *
						Math.max(0, Math.min(1, record.confidence)),
				),
			);
			if (!best || similarity > best.similarity) {
				best = {
					profile: this.recordToImprintProfile(record),
					similarity,
					confidence,
				};
			}
		}
		return best;
	}

	private recordToImprintProfile(
		record: VoiceProfileRecord,
	): VoiceImprintProfile {
		return {
			id: record.profileId,
			centroidEmbedding: record.centroid,
			embeddingModel: record.embeddingModel,
			sampleCount: record.sampleCount,
			confidence: record.confidence,
			label: undefined,
			displayName: undefined,
			entityId: record.entityId,
			sourceKind: undefined,
			sourceScopeId: record.imprintClusterId,
			metadata: record.metadata,
		};
	}

	/**
	 * Speculative match handle. The caller supplies a function that
	 * resolves to a single embedding once `minSpeechMs` of audio is
	 * available. The handle starts the lookup the moment it's
	 * constructed — there is no awaitable for "the encoder finished
	 * before we wanted it to".
	 */
	beginMatch(args: {
		embed: () => Promise<{
			embedding: Float32Array;
			embeddingModel: string;
		} | null>;
		signal?: AbortSignal;
	}): VoiceImprintMatchHandle {
		let current: VoiceImprintMatch | null = null;
		let cancelled = false;
		const onAbort = () => {
			cancelled = true;
		};
		if (args.signal) {
			if (args.signal.aborted) cancelled = true;
			else args.signal.addEventListener("abort", onAbort, { once: true });
		}
		const result = (async (): Promise<VoiceImprintMatch | null> => {
			try {
				const embedded = await args.embed();
				if (cancelled || !embedded) return null;
				const match = await this.findBestMatch(embedded);
				if (cancelled) return null;
				current = match;
				return match;
			} finally {
				if (args.signal) args.signal.removeEventListener("abort", onAbort);
			}
		})();
		return {
			result,
			current: () => current,
			cancel: () => {
				cancelled = true;
			},
		};
	}

	/** Create a new profile from a single capture. */
	async createProfile(args: {
		centroid: Float32Array;
		embeddingModel: string;
		entityId?: string | null;
		imprintClusterId?: string;
		confidence: number;
		durationMs: number;
		consent?: Partial<VoiceProfileConsentState>;
		audioRef?: VoiceProfileAudioRef;
		metadata?: Record<string, unknown>;
	}): Promise<VoiceProfileRecord> {
		const now = iso();
		const centroidArray = Array.from(args.centroid);
		const profileId = deriveProfileId(centroidArray);
		const record: VoiceProfileRecord = {
			schemaVersion: VOICE_PROFILE_RECORD_SCHEMA_VERSION,
			profileId,
			embeddingModel: args.embeddingModel,
			embeddingDim: centroidArray.length,
			centroid: centroidArray,
			variance: new Array(centroidArray.length).fill(0),
			welfordM2: new Array(centroidArray.length).fill(0),
			sampleCount: 1,
			totalDurationMs: Math.max(0, Math.round(args.durationMs)),
			firstObservedAt: now,
			lastObservedAt: now,
			lastRefinedAt: now,
			entityId: args.entityId ?? null,
			imprintClusterId:
				args.imprintClusterId ?? `cluster_${crypto.randomUUID()}`,
			confidence: Math.max(0, Math.min(1, args.confidence)),
			consent: {
				attributionAuthorized: args.consent?.attributionAuthorized ?? false,
				synthesisAuthorized: args.consent?.synthesisAuthorized ?? false,
				...(args.consent?.grantedAt
					? { grantedAt: args.consent.grantedAt }
					: {}),
				...(args.consent?.grantedBy
					? { grantedBy: args.consent.grantedBy }
					: {}),
			},
			...(args.audioRef ? { audioRefs: [args.audioRef] } : {}),
			...(args.metadata ? { metadata: args.metadata } : {}),
		};
		await this.writeProfileToDisk(record);
		this.touchHot(record);
		await this.upsertIndexEntry(record);
		return record;
	}

	/**
	 * Fold one new embedding into the existing profile via the online
	 * running mean (sampleCount-weighted) and update Welford variance.
	 * Rejects outliers if `dropOutliers` is true (default).
	 */
	async refine(args: {
		profileId: string;
		embedding: Float32Array;
		durationMs: number;
		confidence: number;
		audioRef?: VoiceProfileAudioRef;
		dropOutliers?: boolean;
	}): Promise<VoiceProfileRecord | null> {
		const record = await this.ensureLoaded(args.profileId);
		if (!record) return null;
		if (record.embeddingDim !== args.embedding.length) {
			throw new Error(
				`[VoiceProfileStore.refine] embedding dim mismatch: ${record.embeddingDim} vs ${args.embedding.length}`,
			);
		}
		const obs = Array.from(args.embedding);
		if (
			(args.dropOutliers ?? true) &&
			record.sampleCount >= 4 &&
			isOutlier({
				centroid: record.centroid,
				variance: record.variance,
				observation: obs,
			})
		) {
			return record;
		}
		const w = welfordUpdate({
			count: record.sampleCount,
			mean: record.centroid,
			m2: record.welfordM2,
			observation: obs,
		});
		// Re-normalize the mean (kept on the unit sphere for cosine).
		let sumSq = 0;
		for (let i = 0; i < w.mean.length; i += 1) sumSq += w.mean[i] * w.mean[i];
		const inv = sumSq > 0 ? 1 / Math.sqrt(sumSq) : 1;
		const centroid = w.mean.map((v) => v * inv);
		const now = iso();
		const updated: VoiceProfileRecord = {
			...record,
			centroid,
			welfordM2: w.m2,
			variance: welfordVariance(w.m2, w.count),
			sampleCount: w.count,
			totalDurationMs:
				record.totalDurationMs + Math.max(0, Math.round(args.durationMs)),
			confidence: Math.max(
				0,
				Math.min(
					1,
					(record.confidence * record.sampleCount +
						Math.max(0, Math.min(1, args.confidence))) /
						(record.sampleCount + 1),
				),
			),
			lastRefinedAt: now,
			lastObservedAt: now,
			audioRefs: args.audioRef
				? [...(record.audioRefs ?? []), args.audioRef]
				: record.audioRefs,
		};
		await this.writeProfileToDisk(updated);
		this.touchHot(updated);
		await this.upsertIndexEntry(updated);
		return updated;
	}

	async bindEntity(args: {
		profileId: string;
		entityId: string;
		label?: string;
	}): Promise<VoiceProfileRecord | null> {
		const record = await this.ensureLoaded(args.profileId);
		if (!record) return null;
		const updated: VoiceProfileRecord = {
			...record,
			entityId: args.entityId,
			lastObservedAt: iso(),
			metadata: {
				...(record.metadata ?? {}),
				...(args.label ? { label: args.label } : {}),
			},
		};
		await this.writeProfileToDisk(updated);
		this.touchHot(updated);
		await this.upsertIndexEntry(updated);
		return updated;
	}

	async unbindEntity(profileId: string): Promise<VoiceProfileRecord | null> {
		const record = await this.ensureLoaded(profileId);
		if (!record) return null;
		const updated: VoiceProfileRecord = {
			...record,
			entityId: null,
			lastObservedAt: iso(),
		};
		await this.writeProfileToDisk(updated);
		this.touchHot(updated);
		await this.upsertIndexEntry(updated);
		return updated;
	}

	async get(profileId: string): Promise<VoiceProfileRecord | null> {
		return this.ensureLoaded(profileId);
	}

	async list(): Promise<VoiceProfileRecord[]> {
		const index = await this.readIndex();
		const out: VoiceProfileRecord[] = [];
		for (const entry of index.entries) {
			const record = await this.ensureLoaded(entry.profileId);
			if (record) out.push(record);
		}
		return out;
	}

	/** For tests / management — drops a profile. Refuses if entityId is set. */
	async deleteProfile(args: {
		profileId: string;
		allowBoundEntity?: boolean;
	}): Promise<boolean> {
		const record = await this.ensureLoaded(args.profileId);
		if (!record) return false;
		if (record.entityId && !args.allowBoundEntity) {
			throw new Error(
				`[VoiceProfileStore.deleteProfile] refusing to delete ${args.profileId}: bound to entity ${record.entityId}`,
			);
		}
		await fsp.unlink(this.profilePath(args.profileId)).catch(() => {});
		this.hot.delete(args.profileId);
		const index = await this.readIndex();
		index.entries = index.entries.filter((e) => e.profileId !== args.profileId);
		await this.writeIndex(index);
		return true;
	}
}

/** Snapshot of one observation for downstream attribution code. */
export interface VoiceProfileObservation {
	profileId: string;
	imprintClusterId: string;
	entityId: string | null;
	embedding: Float32Array;
	embeddingModel: string;
	confidence: number;
	source?: VoiceInputSource;
	startMs?: number;
	endMs?: number;
}
