/**
 * Single-use records (one-time codes, launch sessions): a write that refuses
 * to overwrite, and a read that deletes atomically so only one reader wins.
 *
 * The Worker cache is Cloudflare KV, which is eventually consistent and has no
 * atomic get-and-delete, so there the records live in the authentication state
 * store instead. Other hosts keep using the cache (Redis or embedded Wadis).
 */
import { cache } from "../cache/client";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { buildAuthenticationState } from "./authentication-state";

function atomicStore() {
  const store = buildAuthenticationState(getCloudAwareEnv());
  if (!store) {
    throw new Error("Single-use record store is unavailable");
  }
  return store;
}

/** Stores `value` under `key` unless the key exists. Returns false on collision. */
export async function putSingleUseRecord(
  key: string,
  value: unknown,
  ttlSeconds: number,
): Promise<boolean> {
  if (cache.supportsAtomicOperations()) {
    return cache.setIfNotExists(key, value, ttlSeconds * 1000);
  }
  const stored = await atomicStore().set(key, JSON.stringify(value), {
    ex: ttlSeconds,
    nx: true,
  });
  return stored !== null;
}

/** Returns the record and deletes it in one step; a second reader gets null. */
export async function takeSingleUseRecord<T>(key: string): Promise<T | null> {
  if (cache.supportsAtomicOperations()) {
    return cache.getAndDelete<T>(key);
  }
  const value: unknown = await atomicStore().getdel(key);
  if (value === null || value === undefined) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/** Whether single-use records can be stored on this host. */
export function isSingleUseRecordStoreAvailable(): boolean {
  return cache.supportsAtomicOperations()
    ? cache.isAvailable()
    : buildAuthenticationState(getCloudAwareEnv()) !== null;
}
