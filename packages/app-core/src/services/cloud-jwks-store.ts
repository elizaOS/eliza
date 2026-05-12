/**
 * Disk-backed JWKS cache for the Eliza Cloud bootstrap-token verifier.
 *
 * The cloud control plane publishes its public keys at
 * `${ELIZA_CLOUD_ISSUER}/.well-known/jwks.json`. We fetch on first use and
 * cache to disk under the eliza state dir so a container restart does not
 * require an online round-trip just to read its own boot token.
 *
 * State dir resolution honours `ELIZA_STATE_DIR` > `ELIZA_STATE_DIR` >
 * `~/.eliza`. The default cache TTL is 6h per the plan.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "@elizaos/core";
import type { RuntimeEnvRecord } from "@elizaos/shared";

export const DEFAULT_JWKS_TTL_MS = 6 * 60 * 60 * 1000;
const JWKS_CACHE_FILENAME = "cloud-jwks.json";

export interface JwksKey {
  kty: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  x?: string;
  y?: string;
  crv?: string;
  k?: string;
  [otherProperty: string]: string | undefined;
}

export interface JwksDocument {
  keys: JwksKey[];
}

interface JwksCacheEnvelope {
  fetchedAt: number;
  issuer: string;
  jwks: JwksDocument;
}

/**
 * Resolve the eliza state directory.
 *
 * Order: `ELIZA_STATE_DIR` → `ELIZA_STATE_DIR` → `~/.eliza`.
 */
export function resolveElizaStateDir(
  env: RuntimeEnvRecord = process.env,
): string {
  return resolveStateDir(env as NodeJS.ProcessEnv);
}

/**
 * Resolve the on-disk path for the JWKS cache.
 *
 * Layout: `<state>/auth/cloud-jwks.json`.
 */
export function resolveJwksCachePath(
  env: RuntimeEnvRecord = process.env,
): string {
  return path.join(resolveElizaStateDir(env), "auth", JWKS_CACHE_FILENAME);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isJwksKey(value: unknown): value is JwksKey {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.kty === "string";
}

function isJwksDocument(value: unknown): value is JwksDocument {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return Array.isArray(candidate.keys) && candidate.keys.every(isJwksKey);
}

function parseEnvelope(raw: string): JwksCacheEnvelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    !isFiniteNumber(candidate.fetchedAt) ||
    typeof candidate.issuer !== "string" ||
    !isJwksDocument(candidate.jwks)
  ) {
    return null;
  }
  return {
    fetchedAt: candidate.fetchedAt,
    issuer: candidate.issuer,
    jwks: candidate.jwks,
  };
}

/**
 * Read the cached JWKS for `issuer`.
 *
 * Returns `null` if the cache file is missing, malformed, written for a
 * different issuer, or older than `ttlMs`. Callers must treat `null` as
 * "must refresh from network" — never as "no keys, allow through".
 */
export async function readCachedJwks(
  issuer: string,
  options: {
    env?: RuntimeEnvRecord;
    now?: number;
    ttlMs?: number;
  } = {},
): Promise<JwksDocument | null> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_JWKS_TTL_MS;
  const filePath = resolveJwksCachePath(env);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const envelope = parseEnvelope(raw);
  if (!envelope) return null;
  if (envelope.issuer !== issuer) return null;
  if (now - envelope.fetchedAt > ttlMs) return null;
  return envelope.jwks;
}

/**
 * Write the JWKS document to disk. The parent directory is created with mode
 * 0700 to keep cached keys out of unrelated reads.
 */
export async function writeCachedJwks(
  issuer: string,
  jwks: JwksDocument,
  options: { env?: RuntimeEnvRecord; now?: number } = {},
): Promise<void> {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const filePath = resolveJwksCachePath(env);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const envelope: JwksCacheEnvelope = { fetchedAt: now, issuer, jwks };
  await fs.writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
