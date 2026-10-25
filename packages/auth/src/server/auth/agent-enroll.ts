/**
 * agent-enroll.ts — keypair-only agent enrollment / self-authentication.
 *
 * The sovereign-custody premise: an agent container boots holding only
 * its identity keypair (+ the Steward endpoint). It must be able to authenticate
 * to Steward and obtain a SHORT-LIVED agent token WITHOUT an operator minting a
 * long-lived token by hand. This module is the crypto + protocol core of that
 * flow; the HTTP surface (routes) and the persistence of `agent_signers` live in
 * the api/plugin layer and are injected here so this file stays db-agnostic and
 * unit-testable in isolation.
 *
 * Protocol (challenge–response, replay-safe):
 *   1. Agent → POST /agents/enroll/challenge { agentId }
 *      Steward returns a random nonce + expiry. The nonce is stored server-side
 *      (single-use, short TTL) via the injected ChallengeStore.
 *   2. Agent signs the CANONICAL challenge string with its P-256 private key.
 *   3. Agent → POST /agents/enroll/verify { agentId, nonce, signature, publicKey? }
 *      Steward consumes the nonce (one-time), resolves the agent's registered
 *      P-256 public key from `agent_signers` (keyType="p256"), verifies the
 *      signature over the canonical string, and — on success — mints a
 *      short-lived agent token.
 *
 * Reuse, not reinvent:
 *   - Signature verification is the SHIPPED `verifyP256Signature` (fail-closed).
 *   - The registered key lives in the SHIPPED `agent_signers.publicKey`
 *     (keyType="p256"); we do not add a new key store.
 *   - The nonce store is the SHIPPED `ChallengeStore` (Redis/PG/memory backends).
 *   - Token minting is the caller's `signAgentToken` (short TTL). This module
 *     never chooses the TTL — the issuance layer owns that policy.
 *
 * Security posture: every failure path returns a typed, non-throwing result. No
 * timing oracle beyond WebCrypto's constant-time verify; the nonce is consumed
 * (deleted) BEFORE verification so a replayed nonce cannot be reused even if the
 * verify races.
 */

import { randomUUID } from "node:crypto";
import { verifyP256Signature } from "./authorization-keys";
import type { ChallengeStore } from "./challenge-store";

/** The canonical-string domain tag. Bound into every signed challenge so an
 * enrollment signature can never be replayed as some OTHER Steward signature
 * (request signing, webhook, …) and vice-versa. */
export const AGENT_ENROLL_DOMAIN = "steward:agent-enroll:v1";

/** Default enrollment-challenge TTL. Deliberately short — the agent signs
 * immediately at boot; a stale challenge is worthless. */
export const AGENT_ENROLL_CHALLENGE_TTL_MS = 2 * 60 * 1000;

/** Agent-id shape accepted by the enrollment core (matches the API's
 * isValidAgentId / agents schema charset). The id is embedded in challenge
 * store keys, so the length cap bounds per-challenge memory (SEC-051). */
export const AGENT_ENROLL_AGENT_ID_RE = /^[a-zA-Z0-9_\-.:]{1,128}$/;

/** Key namespace inside the ChallengeStore so agent-enroll nonces never collide
 * with WebAuthn challenges sharing the same backend. */
function challengeKey(agentId: string, nonce: string): string {
  return `agent-enroll:${agentId}:${nonce}`;
}

/**
 * The exact string an agent signs. Order + tags are FIXED: any drift between the
 * signer and verifier fails closed (signature mismatch). Includes the domain tag,
 * the agentId (binds the signature to a subject), the nonce (single-use), and the
 * issued-at epoch-ms (bounds freshness independently of the store TTL).
 */
export function buildEnrollCanonicalString(input: {
  agentId: string;
  nonce: string;
  issuedAt: number;
}): string {
  return [
    AGENT_ENROLL_DOMAIN,
    input.agentId,
    input.nonce,
    String(input.issuedAt),
  ].join("\n");
}

/** The challenge Steward hands back at step 1. `canonicalString` is exactly what
 * the agent must sign — returned explicitly so a client never has to reconstruct
 * it (and drift). */
export interface AgentEnrollChallenge {
  agentId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  canonicalString: string;
}

/** Result of issuing a challenge. Always ok unless the store write fails. */
export type IssueChallengeResult =
  | { ok: true; challenge: AgentEnrollChallenge }
  | { ok: false; error: string };

/**
 * Step 1: issue a single-use enrollment challenge for an agent and persist the
 * nonce (with its issuedAt) so step 2 can validate it was minted by us. We do
 * NOT check the agent exists here — enumeration resistance: an attacker learns
 * nothing from a challenge, and step 2 (verify) fails closed for unknown/keyless
 * agents anyway.
 */
export async function issueEnrollChallenge(
  store: ChallengeStore,
  agentId: string,
  opts: { ttlMs?: number; now?: number } = {},
): Promise<IssueChallengeResult> {
  const trimmed = typeof agentId === "string" ? agentId.trim() : "";
  if (!trimmed) return { ok: false, error: "agentId required" };
  if (!AGENT_ENROLL_AGENT_ID_RE.test(trimmed)) {
    return { ok: false, error: "invalid agentId" };
  }
  const now = opts.now ?? Date.now();
  const ttlMs = opts.ttlMs ?? AGENT_ENROLL_CHALLENGE_TTL_MS;
  const nonce = randomUUID();
  const issuedAt = now;
  const expiresAt = now + ttlMs;
  // Store the issuedAt alongside the nonce so verify can recompute the exact
  // canonical string and enforce freshness. The KEY carries the nonce (so it is
  // single-use per key); the VALUE carries issuedAt.
  try {
    await store.set(challengeKey(trimmed, nonce), String(issuedAt));
  } catch {
    return { ok: false, error: "challenge store unavailable" };
  }
  return {
    ok: true,
    challenge: {
      agentId: trimmed,
      nonce,
      issuedAt,
      expiresAt,
      canonicalString: buildEnrollCanonicalString({
        agentId: trimmed,
        nonce,
        issuedAt,
      }),
    },
  };
}

/** A resolved agent P-256 signer (the fields verify needs from `agent_signers`). */
export interface ResolvedAgentSigner {
  /** the registered P-256 public key (SPKI b64 / raw / JWK — see importP256PublicKey). */
  publicKey: string;
  /** signer status; only "active" may enroll. */
  status: string;
  /** must be "p256" — an HMAC signer cannot self-enroll (no asymmetric proof). */
  keyType: string;
}

/**
 * Resolver contract: given (agentId), return the agent's ACTIVE p256 signer(s).
 * Multiple keys are allowed (rotation) — verify tries each until one matches.
 * The api/plugin layer implements this against `agent_signers`; this module
 * never touches the db.
 */
export type AgentSignerResolver = (
  agentId: string,
) => Promise<ResolvedAgentSigner[]>;

export type VerifyEnrollResult =
  | { ok: true; agentId: string }
  | { ok: false; error: string; code: EnrollDenyCode };

/** Machine-readable deny reasons (audit + client UX; never leak crypto detail). */
export type EnrollDenyCode =
  | "invalid_input"
  | "challenge_not_found"
  | "challenge_expired"
  | "no_active_key"
  | "signature_invalid";

export interface VerifyEnrollInput {
  agentId: string;
  nonce: string;
  signature: string;
  /** ttl the challenge was minted with (freshness bound), defaults to module const. */
  ttlMs?: number;
  now?: number;
}

/**
 * Step 2: verify an enrollment response. Fail-closed at EVERY step, in this
 * order (each step's failure is terminal):
 *   1. shape check,
 *   2. consume the nonce (single-use: deleted before verify so a replay in flight
 *      cannot reuse it),
 *   3. freshness (issuedAt within ttl of now),
 *   4. resolve active p256 key(s),
 *   5. constant-time signature verify over the recomputed canonical string.
 *
 * On success returns the authenticated agentId; the CALLER mints the short-lived
 * token (this module deliberately does not, so token TTL/scope policy lives in
 * one place — the issuance layer).
 */
export async function verifyEnrollResponse(
  store: ChallengeStore,
  resolveSigners: AgentSignerResolver,
  input: VerifyEnrollInput,
): Promise<VerifyEnrollResult> {
  const agentId = typeof input.agentId === "string" ? input.agentId.trim() : "";
  const nonce = typeof input.nonce === "string" ? input.nonce.trim() : "";
  const signature =
    typeof input.signature === "string" ? input.signature.trim() : "";
  if (!agentId || !nonce || !signature) {
    return {
      ok: false,
      error: "agentId, nonce and signature required",
      code: "invalid_input",
    };
  }
  if (!AGENT_ENROLL_AGENT_ID_RE.test(agentId)) {
    return { ok: false, error: "invalid agentId", code: "invalid_input" };
  }

  const now = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? AGENT_ENROLL_CHALLENGE_TTL_MS;

  // Consume (one-time) BEFORE verifying. A replayed nonce is gone even if the
  // crypto verify below races; the stored value is the issuedAt we minted.
  let issuedAtRaw: string | null;
  try {
    issuedAtRaw = await store.consume(challengeKey(agentId, nonce));
  } catch {
    return {
      ok: false,
      error: "challenge store unavailable",
      code: "challenge_not_found",
    };
  }
  if (issuedAtRaw === null) {
    return {
      ok: false,
      error: "challenge not found or already used",
      code: "challenge_not_found",
    };
  }
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt)) {
    return {
      ok: false,
      error: "challenge malformed",
      code: "challenge_not_found",
    };
  }
  if (now - issuedAt > ttlMs) {
    return { ok: false, error: "challenge expired", code: "challenge_expired" };
  }

  let signers: ResolvedAgentSigner[];
  try {
    signers = await resolveSigners(agentId);
  } catch {
    // Resolver failure is fail-closed: treat as no key.
    return {
      ok: false,
      error: "no active enrollment key for agent",
      code: "no_active_key",
    };
  }
  const active = (signers ?? []).filter(
    (s) =>
      s &&
      s.status === "active" &&
      s.keyType === "p256" &&
      typeof s.publicKey === "string",
  );
  if (active.length === 0) {
    return {
      ok: false,
      error: "no active enrollment key for agent",
      code: "no_active_key",
    };
  }

  const canonical = buildEnrollCanonicalString({ agentId, nonce, issuedAt });
  for (const signer of active) {
    // verifyP256Signature is fail-closed and never throws.
    if (await verifyP256Signature(signer.publicKey, canonical, signature)) {
      return { ok: true, agentId };
    }
  }
  return {
    ok: false,
    error: "signature verification failed",
    code: "signature_invalid",
  };
}
