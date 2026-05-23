import { calculateJwkThumbprint, exportJWK, importPKCS8, type JWK, SignJWT } from "jose";

import { getCloudAwareEnv } from "../runtime/cloud-bindings";

export type AgentTokenMintResult = {
  token: string;
  expiresAt: string;
};

const DEFAULT_TTL_SECONDS = 15 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 60 * 60;
const ISSUER = "eliza-cloud";
const AUDIENCE = "steward";
const ALGORITHM = "RS256";

let cachedPrivateKey: CryptoKey | null = null;
let cachedPrivateKeySource: string | null = null;
let cachedPublicJwk: JWK | null = null;
let cachedPublicJwkSource: string | null = null;
let cachedKeyId: string | null = null;
let cachedKeyIdSource: string | null = null;

function envString(name: string): string | undefined {
  const value = getCloudAwareEnv()[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizePem(value: string): string {
  const trimmed = value.trim().replace(/\\n/g, "\n");
  if (trimmed.includes("-----BEGIN")) return trimmed;
  return `-----BEGIN PRIVATE KEY-----\n${trimmed}\n-----END PRIVATE KEY-----`;
}

function getPrivateKeyPem(): string | undefined {
  const raw =
    envString("AGENT_TOKEN_PRIVATE_KEY_PEM") ?? envString("ELIZA_AGENT_TOKEN_PRIVATE_KEY_PEM");
  return raw ? normalizePem(raw) : undefined;
}

export function isAgentTokenSigningConfigured(): boolean {
  return Boolean(getPrivateKeyPem());
}

export function normalizeAgentTokenTtl(ttl?: unknown): number {
  const requested =
    typeof ttl === "number" && Number.isFinite(ttl) ? Math.floor(ttl) : DEFAULT_TTL_SECONDS;
  return Math.min(Math.max(requested, MIN_TTL_SECONDS), MAX_TTL_SECONDS);
}

function normalizeAgentId(agentId: string): string {
  const normalized = agentId.trim();
  if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(normalized)) {
    throw new Error("invalid agentId");
  }
  return normalized;
}

async function getAgentTokenPrivateKey(): Promise<CryptoKey> {
  const pem = getPrivateKeyPem();
  if (!pem) {
    throw new Error("AGENT_TOKEN_PRIVATE_KEY_PEM is not configured");
  }
  if (cachedPrivateKey && cachedPrivateKeySource === pem) return cachedPrivateKey;
  cachedPrivateKey = await importPKCS8(pem, ALGORITHM, { extractable: true });
  cachedPrivateKeySource = pem;
  cachedPublicJwk = null;
  cachedPublicJwkSource = null;
  cachedKeyId = null;
  cachedKeyIdSource = null;
  return cachedPrivateKey;
}

async function exportedPublicJwkForCurrentKey(): Promise<JWK> {
  const privateKey = await getAgentTokenPrivateKey();
  const jwk = await exportJWK(privateKey);
  // Strip private RSA parameters before exposing the public JWK.
  delete jwk.d;
  delete jwk.p;
  delete jwk.q;
  delete jwk.dp;
  delete jwk.dq;
  delete jwk.qi;
  delete (jwk as Record<string, unknown>).oth;
  return jwk;
}

export async function getAgentTokenKeyId(): Promise<string> {
  const configured = envString("AGENT_TOKEN_KEY_ID") ?? envString("ELIZA_AGENT_TOKEN_KEY_ID");
  if (configured) return configured;

  const pem = getPrivateKeyPem();
  if (!pem) {
    throw new Error("AGENT_TOKEN_PRIVATE_KEY_PEM is not configured");
  }
  if (cachedKeyId && cachedKeyIdSource === pem) return cachedKeyId;

  cachedKeyId = (
    await calculateJwkThumbprint(await exportedPublicJwkForCurrentKey(), "sha256")
  ).slice(0, 16);
  cachedKeyIdSource = pem;
  return cachedKeyId;
}

export async function getAgentTokenPublicJwk(): Promise<JWK> {
  const pem = getPrivateKeyPem();
  if (!pem) {
    throw new Error("AGENT_TOKEN_PRIVATE_KEY_PEM is not configured");
  }
  if (cachedPublicJwk && cachedPublicJwkSource === pem) return cachedPublicJwk;

  const jwk = await exportedPublicJwkForCurrentKey();
  jwk.kid = await getAgentTokenKeyId();
  jwk.alg = ALGORITHM;
  jwk.use = "sig";

  cachedPublicJwk = jwk;
  cachedPublicJwkSource = pem;
  return jwk;
}

export async function getAgentTokenJWKS(): Promise<{ keys: JWK[] }> {
  return { keys: [await getAgentTokenPublicJwk()] };
}

export async function mintAgentToken(
  agentId: string,
  ttl?: unknown,
): Promise<AgentTokenMintResult> {
  const normalizedAgentId = normalizeAgentId(agentId);
  const ttlSeconds = normalizeAgentTokenTtl(ttl);
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAtSeconds = issuedAt + ttlSeconds;
  const privateKey = await getAgentTokenPrivateKey();

  const token = await new SignJWT({ agent_id: normalizedAgentId })
    .setProtectedHeader({ alg: ALGORITHM, typ: "JWT", kid: await getAgentTokenKeyId() })
    .setSubject(`agent:${normalizedAgentId}`)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setNotBefore(issuedAt)
    .setExpirationTime(expiresAtSeconds)
    .sign(privateKey);

  return { token, expiresAt: new Date(expiresAtSeconds * 1000).toISOString() };
}
