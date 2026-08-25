/**
 * One-time Google native sign-in challenges for the first-party mobile client.
 * The direct Redis record binds Google Credential Manager's nonce to the exact
 * mobile PKCE request, so a captured ID token cannot be replayed into a new
 * client, environment, redirect, state, or code challenge.
 */

import {
  buildRedisClient,
  type CompatibleRedis,
  hasRedisConfig,
  type RedisFactoryEnv,
} from "../cache/redis-factory";
import { createOpaqueHex, sha256Hex } from "../oidc/crypto";
import { resolveServerStewardApiUrlFromEnv, type StewardUrlEnv } from "../steward-url";
import type { MobileAppAuthPkceBinding } from "./mobile-app-auth";
import { MOBILE_APP_AUTH_CODE_TTL_SECONDS } from "./mobile-app-auth";

const NONCE_KEY_PREFIX = "mobile-google-auth:nonce";
const NONCE_RECORD_VERSION = 1;
const NONCE_ISSUE_ATTEMPTS = 3;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const MOBILE_GOOGLE_AUTH_NONCE_TTL_SECONDS = MOBILE_APP_AUTH_CODE_TTL_SECONDS;

export interface MobileGoogleAuthEnv extends RedisFactoryEnv, StewardUrlEnv {
  ENVIRONMENT?: string;
  ELIZA_MOBILE_GOOGLE_OIDC_PROVIDER_ID?: string;
  GOOGLE_CLIENT_ID?: string;
  STEWARD_JWT_SECRET?: string;
  STEWARD_SESSION_SECRET?: string;
  STEWARD_REQUEST_SIGNING_SECRET?: string;
  STEWARD_TENANT_ID?: string;
}

export interface MobileGoogleAuthReadiness {
  providerId: string;
  serverClientId: string;
  stewardEndpoint: URL;
  stewardRequestSigningSecret: string;
  tenantId: string;
}

export interface IssuedMobileGoogleAuthNonce {
  expiresAt: string;
  nonce: string;
}

interface MobileGoogleNonceRecord {
  bindingHash: string;
  version: typeof NONCE_RECORD_VERSION;
}

export interface MobileGoogleNonceDependencies {
  buildRedisClient?: (env: MobileGoogleAuthEnv) => CompatibleRedis | null;
  createNonce?: () => string;
  now?: () => number;
}

function configuredString(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function exactEnvironment(value: string | undefined): "production" | "staging" | null {
  return value === "production" || value === "staging" ? value : null;
}

function stewardEndpoint(env: MobileGoogleAuthEnv): URL | null {
  let base: URL;
  try {
    base = new URL(resolveServerStewardApiUrlFromEnv(env));
  } catch {
    // error-policy:J3 invalid deployment configuration is an explicit unavailable signal.
    return null;
  }
  if (base.username || base.password || base.search || base.hash) return null;
  if (
    base.protocol !== "https:" &&
    !(base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname))
  ) {
    return null;
  }
  return new URL(`${base.href.replace(/\/+$/, "")}/auth/jwt/login`);
}

/**
 * Resolve every static prerequisite before native Google sign-in is advertised.
 * Live Redis and Steward failures remain request-time dependency errors.
 */
export function resolveMobileGoogleAuthReadiness(
  env: MobileGoogleAuthEnv,
): MobileGoogleAuthReadiness | null {
  if (!exactEnvironment(env.ENVIRONMENT) || env.MOCK_REDIS === "1" || !hasRedisConfig(env)) {
    return null;
  }
  const providerId = configuredString(env.ELIZA_MOBILE_GOOGLE_OIDC_PROVIDER_ID);
  const serverClientId = configuredString(env.GOOGLE_CLIENT_ID);
  const tenantId = configuredString(env.STEWARD_TENANT_ID);
  const stewardRequestSigningSecret = configuredString(env.STEWARD_REQUEST_SIGNING_SECRET);
  const stewardSessionSecret = configuredString(
    env.STEWARD_JWT_SECRET ?? env.STEWARD_SESSION_SECRET,
  );
  const endpoint = stewardEndpoint(env);
  if (
    !providerId ||
    !serverClientId ||
    !tenantId ||
    !stewardRequestSigningSecret ||
    !stewardSessionSecret ||
    !endpoint
  ) {
    return null;
  }
  return {
    providerId,
    serverClientId,
    stewardEndpoint: endpoint,
    stewardRequestSigningSecret,
    tenantId,
  };
}

async function bindingHash(binding: MobileAppAuthPkceBinding): Promise<string> {
  const stateHash = await sha256Hex(binding.state);
  return await sha256Hex(
    JSON.stringify([
      binding.clientId,
      binding.environment,
      binding.redirectUri,
      stateHash,
      binding.codeChallenge,
      binding.codeChallengeMethod,
      binding.deviceName ?? null,
    ]),
  );
}

async function nonceKey(
  environment: "production" | "staging",
  nonce: string,
  exactBindingHash: string,
): Promise<string> {
  const capabilityHash = await sha256Hex(`${nonce}\n${exactBindingHash}`);
  return `${environment}:${NONCE_KEY_PREFIX}:${capabilityHash}`;
}

function redisClient(
  env: MobileGoogleAuthEnv,
  dependencies: MobileGoogleNonceDependencies,
): CompatibleRedis {
  const redis = (dependencies.buildRedisClient ?? buildRedisClient)(env);
  if (!redis) throw new Error("Mobile Google auth nonce store is unavailable");
  return redis;
}

/** Issue a 256-bit nonce bound to this exact validated mobile PKCE request. */
export async function issueMobileGoogleAuthNonce(
  env: MobileGoogleAuthEnv,
  binding: MobileAppAuthPkceBinding,
  dependencies: MobileGoogleNonceDependencies = {},
): Promise<IssuedMobileGoogleAuthNonce> {
  const environment = exactEnvironment(env.ENVIRONMENT);
  if (!environment || !resolveMobileGoogleAuthReadiness(env)) {
    throw new Error("Mobile Google auth is not configured");
  }
  const redis = redisClient(env, dependencies);
  const exactBindingHash = await bindingHash(binding);
  const now = dependencies.now ?? Date.now;
  for (let attempt = 0; attempt < NONCE_ISSUE_ATTEMPTS; attempt += 1) {
    const nonce = (dependencies.createNonce ?? createOpaqueHex)();
    if (!/^[0-9a-f]{64}$/.test(nonce)) {
      throw new Error("Mobile Google auth nonce generator returned an invalid value");
    }
    const key = await nonceKey(environment, nonce, exactBindingHash);
    const record: MobileGoogleNonceRecord = {
      bindingHash: exactBindingHash,
      version: NONCE_RECORD_VERSION,
    };
    const result = await redis.set(key, record, {
      ex: MOBILE_GOOGLE_AUTH_NONCE_TTL_SECONDS,
      nx: true,
    });
    if (result === "OK") {
      return {
        expiresAt: new Date(now() + MOBILE_GOOGLE_AUTH_NONCE_TTL_SECONDS * 1_000).toISOString(),
        nonce,
      };
    }
  }
  throw new Error("Mobile Google auth nonce collision budget exhausted");
}

/**
 * Atomically consume the challenge for the exact request. A changed binding
 * hashes to a different key and therefore cannot burn the rightful challenge.
 */
export async function consumeMobileGoogleAuthNonce(
  env: MobileGoogleAuthEnv,
  binding: MobileAppAuthPkceBinding,
  nonce: string,
  dependencies: MobileGoogleNonceDependencies = {},
): Promise<boolean> {
  const environment = exactEnvironment(env.ENVIRONMENT);
  if (!environment || !resolveMobileGoogleAuthReadiness(env)) {
    throw new Error("Mobile Google auth is not configured");
  }
  if (!/^[0-9a-f]{64}$/.test(nonce)) return false;
  const redis = redisClient(env, dependencies);
  const exactBindingHash = await bindingHash(binding);
  const key = await nonceKey(environment, nonce, exactBindingHash);
  const record = await redis.getdel<MobileGoogleNonceRecord>(key);
  if (record === null || record === undefined) return false;
  if (record.version !== NONCE_RECORD_VERSION || record.bindingHash !== exactBindingHash) {
    throw new Error("Mobile Google auth nonce record failed integrity validation");
  }
  return true;
}
