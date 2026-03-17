/**
 * Session store for elizaOS.
 *
 * Provides file-based session storage with caching, locking, and
 * atomic updates. Designed to be used as the primary session
 * persistence layer.
 *
 * @module sessions/store
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	mergeSessionEntry,
	type SessionEntry,
	type SessionStore,
} from "./types.js";

// ============================================================================
// Cache Configuration
// ============================================================================

type SessionStoreCacheEntry = {
	store: SessionStore;
	loadedAt: number;
	storePath: string;
	mtimeMs?: number;
};

const SESSION_STORE_CACHE = new Map<string, SessionStoreCacheEntry>();
const DEFAULT_SESSION_STORE_TTL_MS = 45_000; // 45 seconds

function getFileMtimeMs(filePath: string): number | undefined {
	try {
		return fs.statSync(filePath).mtimeMs;
	} catch {
		return undefined;
	}
}

function getSessionStoreTtl(): number {
	const envValue = process.env.ELIZA_SESSION_CACHE_TTL_MS;
	if (envValue) {
		const parsed = Number.parseInt(envValue, 10);
		if (!Number.isNaN(parsed)) {
			return parsed;
		}
	}
	return DEFAULT_SESSION_STORE_TTL_MS;
}

function isCacheEnabled(): boolean {
	return getSessionStoreTtl() > 0;
}

function isCacheValid(entry: SessionStoreCacheEntry): boolean {
	const now = Date.now();
	const ttl = getSessionStoreTtl();
	return now - entry.loadedAt <= ttl;
}

function invalidateCache(storePath: string): void {
	SESSION_STORE_CACHE.delete(storePath);
}

/**
 * Clear all session store caches (for testing).
 */
export function clearSessionStoreCacheForTest(): void {
	SESSION_STORE_CACHE.clear();
}

// ============================================================================
// Store Validation
// ============================================================================

function isSessionStoreRecord(value: unknown): value is SessionStore {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

// ============================================================================
// Delivery Context Normalization
// ============================================================================

type NormalizedDeliveryFields = {
	lastChannel?: string;
	lastTo?: string;
	lastAccountId?: string;
	lastThreadId?: string | number;
	deliveryContext?: SessionEntry["deliveryContext"];
};

function normalizeDeliveryFields(
	entry: SessionEntry,
): NormalizedDeliveryFields {
	const channel = entry.lastChannel?.trim().toLowerCase() || undefined;
	const to = entry.lastTo?.trim() || undefined;
	const accountId = entry.lastAccountId?.trim() || undefined;
	const threadId = entry.lastThreadId ?? entry.deliveryContext?.threadId;

	const deliveryContext =
		channel || to || accountId || threadId
			? { channel, to, accountId, threadId }
			: undefined;

	return {
		lastChannel: channel,
		lastTo: to,
		lastAccountId: accountId,
		lastThreadId: threadId,
		deliveryContext,
	};
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
	const normalized = normalizeDeliveryFields(entry);

	const sameDelivery =
		entry.deliveryContext?.channel === normalized.deliveryContext?.channel &&
		entry.deliveryContext?.to === normalized.deliveryContext?.to &&
		entry.deliveryContext?.accountId ===
			normalized.deliveryContext?.accountId &&
		entry.deliveryContext?.threadId === normalized.deliveryContext?.threadId;

	const sameLast =
		entry.lastChannel === normalized.lastChannel &&
		entry.lastTo === normalized.lastTo &&
		entry.lastAccountId === normalized.lastAccountId &&
		entry.lastThreadId === normalized.lastThreadId;

	if (sameDelivery && sameLast) {
		return entry;
	}

	return {
		...entry,
		deliveryContext: normalized.deliveryContext,
		lastChannel: normalized.lastChannel,
		lastTo: normalized.lastTo,
		lastAccountId: normalized.lastAccountId,
		lastThreadId: normalized.lastThreadId,
	};
}

function normalizeSessionStore(store: SessionStore): void {
	for (const [key, entry] of Object.entries(store)) {
		if (!entry) {
			continue;
		}
		const normalized = normalizeSessionEntryDelivery(entry);
		if (normalized !== entry) {
			store[key] = normalized;
		}
	}
}

// ============================================================================
// Load Session Store
// ============================================================================

export type LoadSessionStoreOptions = {
	/** Skip cache and read directly from disk */
	skipCache?: boolean;
};

/**
 * Load a session store from disk.
 *
 * @param storePath - Path to the store file
 * @param opts - Load options
 * @returns Session store (empty object if file doesn't exist)
 */
export function loadSessionStore(
	storePath: string,
	opts: LoadSessionStoreOptions = {},
): SessionStore {
	// Check cache first
	if (!opts.skipCache && isCacheEnabled()) {
		const cached = SESSION_STORE_CACHE.get(storePath);
		if (cached && isCacheValid(cached)) {
			const currentMtimeMs = getFileMtimeMs(storePath);
			if (currentMtimeMs === cached.mtimeMs) {
				return structuredClone(cached.store);
			}
			invalidateCache(storePath);
		}
	}

	// Load from disk
	let store: SessionStore = {};
	let mtimeMs = getFileMtimeMs(storePath);

	try {
		const raw = fs.readFileSync(storePath, "utf-8");
		const parsed = JSON.parse(raw);
		if (isSessionStoreRecord(parsed)) {
			store = parsed;
		}
		mtimeMs = getFileMtimeMs(storePath) ?? mtimeMs;
	} catch {
		// Missing/invalid store - return empty
	}

	// Best-effort migration: provider → channel naming
	for (const entry of Object.values(store)) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const rec = entry as SessionEntry & Record<string, unknown>;
		if (typeof rec.channel !== "string" && typeof rec.provider === "string") {
			rec.channel = rec.provider;
			delete rec.provider;
		}
		if (
			typeof rec.lastChannel !== "string" &&
			typeof rec.lastProvider === "string"
		) {
			rec.lastChannel = rec.lastProvider;
			delete rec.lastProvider;
		}
	}

	// Cache the result
	if (!opts.skipCache && isCacheEnabled()) {
		SESSION_STORE_CACHE.set(storePath, {
			store: structuredClone(store),
			loadedAt: Date.now(),
			storePath,
			mtimeMs,
		});
	}

	return structuredClone(store);
}

// ============================================================================
// Save Session Store
// ============================================================================

async function saveSessionStoreUnlocked(
	storePath: string,
	store: SessionStore,
): Promise<void> {
	invalidateCache(storePath);
	normalizeSessionStore(store);

	await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
	const json = JSON.stringify(store, null, 2);

	// Windows: avoid atomic rename (can be flaky under concurrent access)
	if (process.platform === "win32") {
		try {
			await fs.promises.writeFile(storePath, json, "utf-8");
		} catch (err) {
			const code =
				err && typeof err === "object" && "code" in err
					? String((err as { code?: unknown }).code)
					: null;
			if (code === "ENOENT") {
				return;
			}
			throw err;
		}
		return;
	}

	// Unix: atomic write with temp file
	const tmp = `${storePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
	try {
		await fs.promises.writeFile(tmp, json, { mode: 0o600, encoding: "utf-8" });
		await fs.promises.rename(tmp, storePath);
		await fs.promises.chmod(storePath, 0o600);
	} catch (err) {
		const code =
			err && typeof err === "object" && "code" in err
				? String((err as { code?: unknown }).code)
				: null;

		if (code === "ENOENT") {
			// Directory may be deleted during tests
			try {
				await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
				await fs.promises.writeFile(storePath, json, {
					mode: 0o600,
					encoding: "utf-8",
				});
				await fs.promises.chmod(storePath, 0o600);
			} catch (err2) {
				const code2 =
					err2 && typeof err2 === "object" && "code" in err2
						? String((err2 as { code?: unknown }).code)
						: null;
				if (code2 === "ENOENT") {
					return;
				}
				throw err2;
			}
			return;
		}

		throw err;
	} finally {
		await fs.promises.rm(tmp, { force: true });
	}
}

// ============================================================================
// Session Store Lock
// ============================================================================

type SessionStoreLockOptions = {
	timeoutMs?: number;
	pollIntervalMs?: number;
	staleMs?: number;
};

async function withSessionStoreLock<T>(
	storePath: string,
	fn: () => Promise<T>,
	opts: SessionStoreLockOptions = {},
): Promise<T> {
	const timeoutMs = opts.timeoutMs ?? 10_000;
	const pollIntervalMs = opts.pollIntervalMs ?? 25;
	const staleMs = opts.staleMs ?? 30_000;
	const lockPath = `${storePath}.lock`;
	const startedAt = Date.now();

	await fs.promises.mkdir(path.dirname(storePath), { recursive: true });

	while (true) {
		try {
			const handle = await fs.promises.open(lockPath, "wx");
			try {
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, startedAt: Date.now() }),
					"utf-8",
				);
			} catch {
				// best-effort
			}
			await handle.close();
			break;
		} catch (err) {
			const code =
				err && typeof err === "object" && "code" in err
					? String((err as { code?: unknown }).code)
					: null;

			if (code === "ENOENT") {
				await fs.promises
					.mkdir(path.dirname(storePath), { recursive: true })
					.catch(() => undefined);
				await new Promise((r) => setTimeout(r, pollIntervalMs));
				continue;
			}

			if (code !== "EEXIST") {
				throw err;
			}

			const now = Date.now();
			if (now - startedAt > timeoutMs) {
				throw new Error(`timeout acquiring session store lock: ${lockPath}`, {
					cause: err,
				});
			}

			// Evict stale locks
			try {
				const st = await fs.promises.stat(lockPath);
				const ageMs = now - st.mtimeMs;
				if (ageMs > staleMs) {
					await fs.promises.unlink(lockPath);
					continue;
				}
			} catch {
				// ignore
			}

			await new Promise((r) => setTimeout(r, pollIntervalMs));
		}
	}

	try {
		return await fn();
	} finally {
		await fs.promises.unlink(lockPath).catch(() => undefined);
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Save a session store to disk with locking.
 *
 * @param storePath - Path to the store file
 * @param store - Store to save
 */
export async function saveSessionStore(
	storePath: string,
	store: SessionStore,
): Promise<void> {
	await withSessionStoreLock(storePath, async () => {
		await saveSessionStoreUnlocked(storePath, store);
	});
}

/**
 * Update a session store with a mutator function.
 *
 * Acquires a lock, reads the store, applies mutations, and saves.
 *
 * @param storePath - Path to the store file
 * @param mutator - Function to mutate the store
 * @returns Result of the mutator function
 */
export async function updateSessionStore<T>(
	storePath: string,
	mutator: (store: SessionStore) => Promise<T> | T,
): Promise<T> {
	return await withSessionStoreLock(storePath, async () => {
		const store = loadSessionStore(storePath, { skipCache: true });
		const result = await mutator(store);
		await saveSessionStoreUnlocked(storePath, store);
		return result;
	});
}

/**
 * Update a single session entry.
 *
 * @param params - Update parameters
 * @returns Updated entry or null if not found
 */
export async function updateSessionStoreEntry(params: {
	storePath: string;
	sessionKey: string;
	update: (entry: SessionEntry) => Promise<Partial<SessionEntry> | null>;
}): Promise<SessionEntry | null> {
	const { storePath, sessionKey, update } = params;

	return await withSessionStoreLock(storePath, async () => {
		// Always re-read inside the lock to avoid stale reads
		const store = loadSessionStore(storePath, { skipCache: true });
		const existing = store[sessionKey];

		if (!existing) {
			return null;
		}

		const patch = await update(existing);
		if (!patch) {
			return existing;
		}

		const next = mergeSessionEntry(existing, patch);
		store[sessionKey] = next;
		await saveSessionStoreUnlocked(storePath, store);
		return next;
	});
}

/**
 * Get a session entry from the store.
 *
 * @param storePath - Path to the store file
 * @param sessionKey - Session key to look up
 * @returns Session entry or undefined
 */
export function getSessionEntry(
	storePath: string,
	sessionKey: string,
): SessionEntry | undefined {
	const store = loadSessionStore(storePath);
	return store[sessionKey];
}

/**
 * Get a session entry by session ID.
 *
 * @param storePath - Path to the store file
 * @param sessionId - Session ID to look up
 * @returns Session entry or undefined
 */
export function getSessionEntryById(
	storePath: string,
	sessionId: string,
): SessionEntry | undefined {
	const store = loadSessionStore(storePath);
	return Object.values(store).find((e) => e?.sessionId === sessionId);
}

/**
 * Get the updated timestamp for a session.
 *
 * @param params - Query parameters
 * @returns Timestamp or undefined
 */
export function readSessionUpdatedAt(params: {
	storePath: string;
	sessionKey: string;
}): number | undefined {
	try {
		const store = loadSessionStore(params.storePath);
		return store[params.sessionKey]?.updatedAt;
	} catch {
		return undefined;
	}
}

/**
 * Create or update a session entry.
 *
 * @param params - Upsert parameters
 * @returns The created/updated entry
 */
export async function upsertSessionEntry(params: {
	storePath: string;
	sessionKey: string;
	patch: Partial<SessionEntry>;
}): Promise<SessionEntry> {
	const { storePath, sessionKey, patch } = params;

	return await updateSessionStore(storePath, (store) => {
		const existing = store[sessionKey];
		const next = mergeSessionEntry(existing, patch);
		store[sessionKey] = next;
		return next;
	});
}

/**
 * Delete a session entry.
 *
 * @param params - Delete parameters
 * @returns True if entry was deleted
 */
export async function deleteSessionEntry(params: {
	storePath: string;
	sessionKey: string;
}): Promise<boolean> {
	const { storePath, sessionKey } = params;

	return await updateSessionStore(storePath, (store) => {
		if (sessionKey in store) {
			delete store[sessionKey];
			return true;
		}
		return false;
	});
}

/**
 * List all session keys in a store.
 *
 * @param storePath - Path to the store file
 * @returns Array of session keys
 */
export function listSessionKeys(storePath: string): string[] {
	const store = loadSessionStore(storePath);
	return Object.keys(store);
}

/**
 * List all sessions with their entries.
 *
 * @param storePath - Path to the store file
 * @returns Array of [key, entry] tuples
 */
export function listSessions(storePath: string): Array<[string, SessionEntry]> {
	const store = loadSessionStore(storePath);
	return Object.entries(store).filter(
		(entry): entry is [string, SessionEntry] => entry[1] != null,
	);
}
