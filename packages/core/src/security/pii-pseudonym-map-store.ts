/**
 * Protected persistence for the corpus pseudonym map (#14805).
 *
 * The alias→pseudonym map inverts the scrub, so **the map itself is a secret
 * artifact**: owner-only, never embedded, never indexed, never retrievable.
 * The issue mandates structural confidentiality — the map lives OUTSIDE the
 * retrievable corpus, in a store with NO ingestion path — plus at-rest
 * protection (the "vault-encrypted blob" option):
 *
 * - **Structural isolation.** The snapshot is persisted as a single value in
 *   the runtime cache (the adapter-backed durable KV the scrub done-markers
 *   already use, `./pii-scrub-markers.ts`) under the dedicated key
 *   {@link PII_PSEUDONYM_MAP_CACHE_KEY}. Cache rows are NEVER a document or
 *   memory row: they are not chunked into `document_fragments`, not embedded,
 *   and unreachable via `searchDocuments`, `searchMessages`, `searchMemories`,
 *   and the `SEARCH_KNOWLEDGE` action — there is no ingestion path from the
 *   cache into any retrieval surface. The cache table is additionally
 *   agent-scoped by the SQL adapter (owner's agent only).
 * - **Encrypted at rest, fail-closed.** The blob is AES-256-GCM ciphertext
 *   (v2 settings-secret scheme: key = SHA-256(salt), 12-byte IV, auth tag)
 *   under the dedicated AAD {@link PII_PSEUDONYM_MAP_AAD} — domain-separated
 *   from settings ciphertext so neither store can be coaxed into decrypting
 *   the other's blobs. `save` REFUSES to persist plaintext; `load` throws on
 *   a wrong key, tampered ciphertext, or a malformed snapshot rather than
 *   returning a partial map (a partial map would silently re-mint pseudonyms
 *   for already-mapped people — a corpus-wide consistency break). Note this is
 *   deliberately stricter than `decryptStringValue` in `../settings.ts`, which
 *   returns the raw value on failure — acceptable for settings, fail-open for
 *   a secret artifact.
 *
 * The encryption salt follows the canonical secret-settings lifecycle
 * (`getSalt()`, `SECRET_SALT`) so the map is protected by the same key
 * material and production non-default enforcement as every other at-rest
 * secret. The map's *mint* salt is a separate secret that lives INSIDE the
 * encrypted snapshot (see `./pii-pseudonym-map.ts`).
 */

import { getSalt } from "../settings.js";
import { BufferUtils } from "../utils/buffer.js";
import {
	createHash,
	decryptAes256Gcm,
	encryptAes256Gcm,
} from "../utils/crypto-compat.js";
import {
	assertValidSnapshot,
	type PseudonymMapSnapshot,
} from "./pii-pseudonym-map.js";
import type { ScrubMarkerCache } from "./pii-scrub-markers.js";

/**
 * The single cache key the map is persisted under. Deliberately inside the
 * `pii:` namespace next to the scrub done-markers; the trailing `:v1` is the
 * BLOB FORMAT version (snapshot schema), not the scrub ruleset version.
 */
export const PII_PSEUDONYM_MAP_CACHE_KEY = "pii:pseudonym-map:v1";

/** Domain-separation AAD for the map ciphertext. */
export const PII_PSEUDONYM_MAP_AAD = "elizaos:pii-pseudonym-map:v1";

/** Ciphertext format marker (mirrors the settings v2 layout). */
const CIPHERTEXT_PREFIX = "v2";

/** Thrown when the protected store cannot prove the artifact is intact. */
export class PseudonymMapStoreError extends Error {
	constructor(message: string) {
		super(`Pseudonym map store (fail-closed): ${message}`);
		this.name = "PseudonymMapStoreError";
	}
}

/**
 * Persistence seam for the corpus pseudonym map. Implementations MUST keep the
 * artifact outside every retrieval surface (never a document/memory row, never
 * embedded, never indexed) — confidentiality is structural, not filter-based.
 */
export interface PseudonymMapStore {
	/** The persisted snapshot, or `null` when none exists yet. */
	load(): Promise<PseudonymMapSnapshot | null>;
	/** Persist the snapshot (idempotent overwrite of the single artifact). */
	save(snapshot: PseudonymMapSnapshot): Promise<void>;
}

export interface EncryptedCachePseudonymMapStoreOptions {
	/**
	 * Encryption salt. Defaults to the canonical secret-settings salt
	 * (`getSalt()` — `SECRET_SALT`, production-enforced non-default). Tests pass
	 * a fixed value.
	 */
	readonly encryptionSalt?: string;
}

/**
 * The default protected store: AES-256-GCM-encrypted blob in the runtime
 * cache under {@link PII_PSEUDONYM_MAP_CACHE_KEY}. See the module doc for the
 * confidentiality contract.
 */
export class EncryptedCachePseudonymMapStore implements PseudonymMapStore {
	private readonly cache: ScrubMarkerCache;
	private readonly key: Uint8Array;

	constructor(
		cache: ScrubMarkerCache,
		options: EncryptedCachePseudonymMapStoreOptions = {},
	) {
		this.cache = cache;
		const salt = options.encryptionSalt ?? getSalt();
		if (typeof salt !== "string" || salt.length === 0) {
			throw new PseudonymMapStoreError(
				"no encryption salt available; refusing to operate an unencrypted map store",
			);
		}
		this.key = createHash("sha256").update(salt).digest().slice(0, 32);
	}

	async load(): Promise<PseudonymMapSnapshot | null> {
		const stored = await this.cache.getCache<string>(
			PII_PSEUDONYM_MAP_CACHE_KEY,
		);
		if (stored === undefined || stored === null) return null;
		if (typeof stored !== "string") {
			throw new PseudonymMapStoreError(
				"stored artifact is not a string (unexpected shape in the cache)",
			);
		}
		const parts = stored.split(":");
		if (parts.length !== 4 || parts[0] !== CIPHERTEXT_PREFIX) {
			throw new PseudonymMapStoreError(
				"stored artifact is not v2 ciphertext; refusing to interpret it",
			);
		}
		let plaintext: string;
		try {
			const iv = BufferUtils.fromHex(parts[1]);
			const ciphertext = BufferUtils.fromHex(parts[2]);
			const tag = BufferUtils.fromHex(parts[3]);
			const aad = new TextEncoder().encode(PII_PSEUDONYM_MAP_AAD);
			const bytes = decryptAes256Gcm(this.key, iv, ciphertext, tag, aad);
			plaintext = BufferUtils.bufferToString(bytes, "utf8");
		} catch (error) {
			throw new PseudonymMapStoreError(
				`decryption failed (wrong SECRET_SALT or tampered artifact): ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(plaintext);
		} catch {
			throw new PseudonymMapStoreError("decrypted artifact is not valid JSON");
		}
		// Structural fail-closed validation: never return a partial map.
		assertValidSnapshot(parsed);
		return parsed;
	}

	async save(snapshot: PseudonymMapSnapshot): Promise<void> {
		// Validate before persisting so a corrupted in-memory map can never
		// clobber a good artifact.
		assertValidSnapshot(snapshot);
		const plaintext = JSON.stringify(snapshot);
		const iv = BufferUtils.randomBytes(12);
		const aad = new TextEncoder().encode(PII_PSEUDONYM_MAP_AAD);
		const { ciphertext, tag } = encryptAes256Gcm(
			this.key,
			iv,
			BufferUtils.fromString(plaintext, "utf8"),
			aad,
		);
		const blob = `${CIPHERTEXT_PREFIX}:${BufferUtils.toHex(iv)}:${BufferUtils.toHex(
			ciphertext,
		)}:${BufferUtils.toHex(tag)}`;
		// Tripwire: the persisted value MUST be ciphertext. A plaintext write of
		// the alias↔pseudonym table would invert the scrub for anyone who reads
		// the cache — refuse rather than degrade.
		if (!blob.startsWith(`${CIPHERTEXT_PREFIX}:`) || blob.includes("{")) {
			throw new PseudonymMapStoreError(
				"refusing to persist a non-ciphertext pseudonym map artifact",
			);
		}
		const ok = await this.cache.setCache<string>(
			PII_PSEUDONYM_MAP_CACHE_KEY,
			blob,
		);
		if (!ok) {
			throw new PseudonymMapStoreError(
				"cache write failed; the map artifact was NOT persisted",
			);
		}
	}
}
