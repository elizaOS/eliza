/**
 * Voice-session consent nonce (SEC-21) — a server-enforced mint precondition.
 *
 * The threat: an ambient/voice session can be minted API-direct with no consent
 * UI, no indicator, and an empty downlink, so the server would start paying for
 * a live mic stream with no proof the human ever agreed. The mitigation is to
 * make consent a SERVER-ENFORCED precondition of mint, not a client promise: a
 * visible consent action issues a one-time nonce; `POST /session` refuses to
 * mint without a valid, unconsumed nonce for that user.
 *
 * Nonces are:
 *   - single-use (consumed atomically on mint; a replay is refused);
 *   - short-lived (a stale consent must be re-affirmed);
 *   - scoped to the issuing user (a nonce for user A cannot mint for user B).
 *
 * When no Redis backend is configured the nonce store is unavailable. Because
 * consent is a hard precondition, an unconfigured store means mint is refused
 * rather than silently allowed — we never fabricate consent.
 */

import {
  buildRedisClient,
  type CompatibleRedis,
  hasRedisConfig,
  isCloudflareWorkerRuntime,
  type RedisFactoryEnv,
} from "../cache/redis-factory";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";

const CONSENT_KEY_PREFIX = "voice-session:consent:";
const ENV_PREFIX = process.env.ENVIRONMENT || "local";
export const CONSENT_NONCE_TTL_SECONDS = 300;

let cachedRedis: CompatibleRedis | null = null;

function getRedis(): CompatibleRedis | null {
  if (!isCloudflareWorkerRuntime() && cachedRedis) return cachedRedis;
  // On Workers, Redis credentials live on `c.env`, exposed via
  // getCloudAwareEnv(); passing process.env would miss them.
  const client = buildRedisClient(getCloudAwareEnv() as unknown as RedisFactoryEnv);
  if (client && !isCloudflareWorkerRuntime()) cachedRedis = client;
  return client;
}

function consentKey(userId: string, nonce: string): string {
  return `${ENV_PREFIX}:${CONSENT_KEY_PREFIX}${userId}:${nonce}`;
}

export function isConsentStoreConfigured(): boolean {
  return hasRedisConfig(getCloudAwareEnv() as unknown as RedisFactoryEnv);
}

export interface IssuedConsentNonce {
  nonce: string;
  expiresAt: string;
}

/**
 * Issue a one-time consent nonce for a user. Called by the visible consent
 * action (a UI affordance), NOT by the mint. Returns null when no durable store
 * is configured (consent cannot be tracked, so it cannot be honestly granted).
 */
export async function issueConsentNonce(userId: string): Promise<IssuedConsentNonce | null> {
  if (typeof userId !== "string" || userId.trim() === "") {
    throw new Error("issueConsentNonce requires a userId");
  }
  const redis = getRedis();
  if (!redis) return null;
  const nonce = crypto.randomUUID();
  await redis.set(consentKey(userId, nonce), "1", { ex: CONSENT_NONCE_TTL_SECONDS });
  return {
    nonce,
    expiresAt: new Date(Date.now() + CONSENT_NONCE_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Atomically consume a consent nonce as a mint precondition. Returns true only
 * if the nonce existed for this user and was consumed by THIS call (single-use).
 * A missing store, a missing/expired nonce, or a replay all return false, which
 * the mint route translates into a refusal.
 */
export async function consumeConsentNonce(userId: string, nonce: string): Promise<boolean> {
  if (
    typeof userId !== "string" ||
    userId.trim() === "" ||
    typeof nonce !== "string" ||
    nonce.trim() === ""
  ) {
    return false;
  }
  const redis = getRedis();
  if (!redis) return false;
  // `getdel` is atomic: the first consumer wins, replays see null.
  const value = await redis.getdel(consentKey(userId, nonce));
  return value !== null && value !== undefined;
}

/** Test-only: drop the cached client so a fresh env is observed. */
export function __resetConsentNonceClientForTests(): void {
  cachedRedis = null;
}
