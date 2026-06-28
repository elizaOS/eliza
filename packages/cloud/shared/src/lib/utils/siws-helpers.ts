/**
 * SIWS (Sign-In With Solana) helpers — Solana counterpart to siwe-helpers.
 * Mirrors the SIWE EIP-4361 message shape but verifies an ed25519 signature
 * against a base58 public key using tweetnacl.
 *
 * Message format (line-for-line):
 *   {domain} wants you to sign in with your Solana account:
 *   {address}
 *
 *   {statement}
 *
 *   URI: {uri}
 *   Version: 1
 *   Chain ID: {chainId}
 *   Nonce: {nonce}
 *   Issued At: {issuedAt}
 *   [Expiration Time: {expirationTime}]
 *   [Not Before: {notBefore}]
 *
 * Address (base58) is case-sensitive — DO NOT lowercase it anywhere.
 */

import bs58 from "bs58";
import nacl from "tweetnacl";
import { CacheKeys, CacheTTL } from "../cache/keys";
import type { CompatibleRedis } from "../cache/redis-factory";

const NONCE_BYTES = 16;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface SiwsMessage {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  version: string;
  chainId: string;
  nonce: string;
  issuedAt: Date;
  expirationTime?: Date;
  notBefore?: Date;
}

function randomNonceHex(): string {
  const arr = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function issueSiwsNonce(redis: CompatibleRedis): Promise<string> {
  const nonce = randomNonceHex();
  await redis.setex(CacheKeys.siws.nonce(nonce), CacheTTL.siws.nonce, "1");
  return nonce;
}

async function consumeSiwsNonce(redis: CompatibleRedis, nonce: string): Promise<boolean> {
  const value = await redis.getdel(CacheKeys.siws.nonce(nonce));
  return value !== null;
}

export function parseSiwsMessage(message: string): SiwsMessage {
  const lines = message.split("\n");
  if (lines.length < 7) {
    throw new Error("SIWS message too short");
  }

  const header = lines[0] ?? "";
  const headerMatch = header.match(/^(.+?) wants you to sign in with your Solana account:$/);
  if (!headerMatch) {
    throw new Error("SIWS message missing header");
  }
  const domain = headerMatch[1];
  const address = (lines[1] ?? "").trim();
  if (!SOLANA_ADDRESS_RE.test(address)) {
    throw new Error("SIWS message address is not a valid base58 Solana address");
  }

  const fields: Record<string, string> = {};
  let statement: string | undefined;

  // Lines 2..N: optional blank/statement/blank, then key:value pairs
  let i = 2;
  if (lines[i] === "" && lines[i + 1] !== undefined && !lines[i + 1].includes(":")) {
    statement = lines[i + 1];
    i += 3; // blank, statement, blank
  } else if (lines[i] === "") {
    i += 1;
  }

  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    fields[key] = value;
  }

  const uri = fields["URI"];
  const version = fields["Version"];
  const chainId = fields["Chain ID"];
  const nonce = fields["Nonce"];
  const issuedAtStr = fields["Issued At"];
  if (!uri || !version || !chainId || !nonce || !issuedAtStr) {
    throw new Error("SIWS message missing required field");
  }
  const issuedAt = new Date(issuedAtStr);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new Error("SIWS message Issued At is not a valid date");
  }
  const expirationTime = fields["Expiration Time"]
    ? new Date(fields["Expiration Time"])
    : undefined;
  const notBefore = fields["Not Before"] ? new Date(fields["Not Before"]) : undefined;

  return {
    domain,
    address,
    statement,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime,
    notBefore,
  };
}

export function buildSiwsMessage(params: {
  domain: string;
  address: string;
  statement?: string;
  uri: string;
  chainId: string;
  nonce: string;
  issuedAt?: Date;
  expirationTime?: Date;
}): string {
  const issuedAt = (params.issuedAt ?? new Date()).toISOString();
  const lines = [
    `${params.domain} wants you to sign in with your Solana account:`,
    params.address,
    "",
  ];
  if (params.statement) {
    lines.push(params.statement, "");
  }
  lines.push(
    `URI: ${params.uri}`,
    `Version: 1`,
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${issuedAt}`,
  );
  if (params.expirationTime) {
    lines.push(`Expiration Time: ${params.expirationTime.toISOString()}`);
  }
  return lines.join("\n");
}

/**
 * Validates an SIWS message + base58 signature against the encoded message bytes.
 * @param expectedHost — the domain the API expects (from getAppHost).
 * @param signatureBase58 — detached ed25519 signature, base58-encoded.
 * @throws Error on any validation failure.
 */
export function validateSIWSMessage(
  message: string,
  signatureBase58: string,
  expectedHost: string,
): { address: string; parsed: SiwsMessage } {
  const parsed = parseSiwsMessage(message);
  if (parsed.domain !== expectedHost) {
    throw new Error(
      `SIWS domain does not match app host: got ${parsed.domain}, expected ${expectedHost}`,
    );
  }
  const now = Date.now();
  if (parsed.expirationTime && parsed.expirationTime.getTime() <= now) {
    throw new Error("SIWS message has expired");
  }
  if (parsed.notBefore && parsed.notBefore.getTime() > now) {
    throw new Error("SIWS message not yet valid");
  }

  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = bs58.decode(signatureBase58);
  const pubkeyBytes = bs58.decode(parsed.address);
  if (pubkeyBytes.length !== 32) {
    throw new Error("SIWS address is not a 32-byte ed25519 public key");
  }
  if (signatureBytes.length !== 64) {
    throw new Error("SIWS signature is not 64 bytes");
  }
  const ok = nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
  if (!ok) {
    throw new Error("SIWS signature invalid");
  }
  return { address: parsed.address, parsed };
}

export async function validateAndConsumeSIWS(
  redis: CompatibleRedis,
  message: string,
  signatureBase58: string,
  expectedHost: string,
): Promise<{ address: string; parsed: SiwsMessage }> {
  const result = validateSIWSMessage(message, signatureBase58, expectedHost);
  const consumed = await consumeSiwsNonce(redis, result.parsed.nonce);
  if (!consumed) {
    throw new Error("SIWS nonce invalid or already used");
  }
  return result;
}
