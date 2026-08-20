/**
 * One-time, session-bound HMAC proofs for OAuth success redirects.
 *
 * Callbacks mint a short-lived signed ticket bound to the OAuth org/user and
 * register its nonce for single consumption. The public verify endpoint checks
 * the visitor's session against that binding and consumes the nonce so a
 * forwarded URL cannot claim "your account" for another browser, and a replay
 * cannot succeed after the first verify.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type BoundCapabilityRequest,
  normalizeBoundCapabilityRequest,
} from "@elizaos/core/types/provider-integrations";
import { oauthSuccessProofTicketsRepository } from "../../../db/repositories/oauth-success-proof-tickets";
import { getCloudAwareEnv } from "../../runtime/cloud-bindings";
import { getAllProviderIds } from "./provider-registry";

const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** Reject absurd query-string proofs before HMAC work (payload.sig base64url). */
const MAX_PROOF_CHARS = 2_048;

/** Connector-native providers that emit `*_connected` but are outside OAUTH_PROVIDERS. */
const EXTRA_CONNECTED_MARKERS = new Set(["discord"]);

/** Own-property provider ids only — never Object.prototype names via `in`. */
const KNOWN_OAUTH_PROVIDER_IDS = new Set(getAllProviderIds().map((id) => id.toLowerCase()));

/** Reserved OAuth success query keys rewritten by callbacks. */
const OAUTH_SUCCESS_RESERVED_PARAMS = new Set(["proof", "platform", "connection_id"]);

/**
 * True for known OAuth provider completion markers (`github_connected`, …).
 * Caller-owned keys like `socket_connected` / `constructor_connected` must not match.
 */
export function isOAuthSuccessConnectedParam(key: string): boolean {
  if (!key.endsWith("_connected")) return false;
  const platform = key.slice(0, -"_connected".length).toLowerCase();
  if (!platform) return false;
  return KNOWN_OAUTH_PROVIDER_IDS.has(platform) || EXTRA_CONNECTED_MARKERS.has(platform);
}

/**
 * Whether this redirect targets the public `/auth/success` landing page that
 * consumes HMAC proofs. Dashboard and other callback consumers must not receive
 * transferable proof tokens in the URL.
 */
export function isOAuthSuccessLandingPath(pathname: string): boolean {
  // Exact path only — never a suffix match. `/foo/auth/success` is not the
  // public landing page and must not receive transferable HMAC proofs.
  const normalized = pathname.replace(/\/+$/, "") || "/";
  return normalized === "/auth/success";
}

/**
 * Drop only reserved OAuth success markers from a redirect URL before writing
 * a fresh completion, preserving unrelated caller query state.
 */
export function clearOAuthSuccessParams(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (OAUTH_SUCCESS_RESERVED_PARAMS.has(key) || isOAuthSuccessConnectedParam(key)) {
      url.searchParams.delete(key);
    }
  }
}

export interface OAuthSuccessProofPayload {
  platform: string;
  connectionId: string | null;
  organizationId: string;
  userId: string;
  exp: number;
  nonce: string;
  capabilityContinuation: BoundCapabilityRequest | null;
}

/** Server-side ticket record stored under the proof nonce for one-time consume. */
export interface OAuthSuccessProofTicket {
  platform: string;
  connectionId: string | null;
  organizationId: string;
  userId: string;
  exp: number;
}

/**
 * Pluggable ticket store so unit tests can hermetically exercise mint/consume
 * without a live database. Production uses Postgres because the deployed
 * Worker cache is Cloudflare KV and cannot atomically consume a nonce.
 *
 * Contract:
 * - {@link put} MUST report whether durable storage acknowledged the write.
 *   Callers fail closed when it resolves `false`.
 * - {@link take} MUST be an atomic get-and-delete (single one-time consume).
 *   The default implementation uses Postgres `DELETE … RETURNING`.
 */
export interface OAuthSuccessProofTicketStore {
  /** Returns true only when the backend acknowledged a durable write. */
  put(nonce: string, ticket: OAuthSuccessProofTicket, ttlSeconds: number): Promise<boolean>;
  /** Atomic get-and-delete. Returns null when missing or already consumed. */
  take(nonce: string): Promise<OAuthSuccessProofTicket | null>;
}

const defaultTicketStore: OAuthSuccessProofTicketStore = {
  async put(nonce, ticket, _ttlSeconds) {
    await oauthSuccessProofTicketsRepository.purgeExpired();
    await oauthSuccessProofTicketsRepository.insert({
      nonce_hash: hashNonce(nonce),
      platform: ticket.platform,
      connection_id: ticket.connectionId,
      organization_id: ticket.organizationId,
      user_id: ticket.userId,
      expires_at: new Date(ticket.exp),
    });
    return true;
  },
  async take(nonce) {
    const claimed = await oauthSuccessProofTicketsRepository.claim(hashNonce(nonce));
    if (!claimed) return null;
    return {
      platform: claimed.platform,
      connectionId: claimed.connection_id,
      organizationId: claimed.organization_id,
      userId: claimed.user_id,
      exp: claimed.expires_at.getTime(),
    };
  },
};

let ticketStore: OAuthSuccessProofTicketStore = defaultTicketStore;

/** Test-only override of the one-time ticket store. Pass null to restore default. */
export function __setOAuthSuccessProofTicketStoreForTests(
  store: OAuthSuccessProofTicketStore | null,
): void {
  ticketStore = store ?? defaultTicketStore;
}

/** In-memory ticket store for hermetic replay/binding tests. */
export function createMemoryOAuthSuccessProofTicketStore(): OAuthSuccessProofTicketStore {
  const tickets = new Map<string, { ticket: OAuthSuccessProofTicket; expiresAtMs: number }>();
  return {
    async put(nonce, ticket, ttlSeconds) {
      tickets.set(nonce, {
        ticket,
        expiresAtMs: Date.now() + ttlSeconds * 1000,
      });
      return true;
    },
    async take(nonce) {
      const entry = tickets.get(nonce);
      if (!entry) return null;
      tickets.delete(nonce);
      if (entry.expiresAtMs < Date.now()) return null;
      return entry.ticket;
    },
  };
}

function resolveProofSecret(): string | null {
  const env = getCloudAwareEnv();
  // Prefer a dedicated secret; fall back to already-provisioned Worker secrets
  // so production mints proofs without a new binding cutover.
  const secret =
    env.OAUTH_SUCCESS_PROOF_SECRET?.trim() ||
    env.STEWARD_SESSION_SECRET?.trim() ||
    env.STEWARD_JWT_SECRET?.trim() ||
    env.NEXTAUTH_SECRET?.trim() ||
    env.SESSION_SECRET?.trim() ||
    env.AUTH_SECRET?.trim() ||
    "";
  return secret.length >= 16 ? secret : null;
}

function b64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

function sign(secret: string, payloadB64: string): string {
  return b64url(createHmac("sha256", secret).update(payloadB64).digest());
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function hashNonce(nonce: string): string {
  return createHash("sha256").update(nonce).digest("hex");
}

function ticketKeyTtlSeconds(expMs: number): number {
  const remainingMs = Math.max(0, expMs - Date.now());
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * Mint a proof for a completed OAuth callback. Registers a one-time ticket
 * bound to the OAuth org/user. Returns null when no signing secret is
 * configured (callers fail closed for `/auth/success` without ownership).
 */
export async function mintOAuthSuccessProof(args: {
  platform: string;
  connectionId?: string | null;
  organizationId: string;
  userId: string;
  capabilityContinuation?: BoundCapabilityRequest | null;
  ttlMs?: number;
}): Promise<string | null> {
  const secret = resolveProofSecret();
  if (!secret) return null;
  const platform = args.platform.trim().toLowerCase();
  const organizationId = args.organizationId.trim();
  const userId = args.userId.trim();
  if (!platform || !organizationId || !userId) return null;
  const connectionId =
    typeof args.connectionId === "string" && args.connectionId.trim()
      ? args.connectionId.trim()
      : null;
  const exp = Date.now() + (args.ttlMs ?? DEFAULT_TTL_MS);
  const nonce = randomBytes(16).toString("hex");
  const payload: OAuthSuccessProofPayload = {
    platform,
    connectionId,
    organizationId,
    userId,
    exp,
    nonce,
    capabilityContinuation: args.capabilityContinuation
      ? normalizeBoundCapabilityRequest(args.capabilityContinuation)
      : null,
  };
  const ticket: OAuthSuccessProofTicket = {
    platform,
    connectionId,
    organizationId,
    userId,
    exp,
  };
  let written: boolean;
  try {
    written = await ticketStore.put(nonce, ticket, ticketKeyTtlSeconds(exp));
  } catch {
    // error-policy:J1 ticket registration failure — cannot mint a consumable proof.
    return null;
  }
  // Fail closed: if the store did not acknowledge a durable write (backend
  // unavailable, invalid value, or an error), do not sign/return a proof. The
  // legacy `cache.set` wrapper discarded this outcome and minted an unconsumable
  // proof (#18114).
  if (!written) return null;
  const payloadB64 = b64url(JSON.stringify(payload));
  const signature = sign(secret, payloadB64);
  return `${payloadB64}.${signature}`;
}

export type ConsumeOAuthSuccessProofReason =
  | "missing_secret"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "already_used"
  | "binding_mismatch"
  | "ticket_store_unavailable";

export type ConsumeOAuthSuccessProofResult =
  | { ok: true; payload: OAuthSuccessProofPayload }
  | { ok: false; reason: ConsumeOAuthSuccessProofReason };

/**
 * Verify HMAC, require the visitor session to match the mint-time org/user,
 * then consume the nonce ticket exactly once.
 */
export async function consumeOAuthSuccessProof(
  proof: string | null | undefined,
  binding: { organizationId: string; userId: string },
): Promise<ConsumeOAuthSuccessProofResult> {
  const secret = resolveProofSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (typeof proof !== "string" || !proof.trim()) {
    return { ok: false, reason: "malformed" };
  }
  const trimmed = proof.trim();
  if (trimmed.length > MAX_PROOF_CHARS) {
    return { ok: false, reason: "malformed" };
  }
  const parts = trimmed.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return { ok: false, reason: "malformed" };
  const expected = sign(secret, payloadB64);
  if (!safeEqual(expected, signature)) {
    return { ok: false, reason: "bad_signature" };
  }

  let payload: OAuthSuccessProofPayload;
  try {
    const raw = JSON.parse(
      b64urlDecode(payloadB64).toString("utf8"),
    ) as Partial<OAuthSuccessProofPayload>;
    if (
      typeof raw.platform !== "string" ||
      !raw.platform.trim() ||
      typeof raw.organizationId !== "string" ||
      !raw.organizationId.trim() ||
      typeof raw.userId !== "string" ||
      !raw.userId.trim() ||
      typeof raw.exp !== "number" ||
      !Number.isFinite(raw.exp) ||
      typeof raw.nonce !== "string" ||
      !raw.nonce.trim()
    ) {
      return { ok: false, reason: "malformed" };
    }
    if (raw.exp < Date.now()) return { ok: false, reason: "expired" };
    const connectionId =
      typeof raw.connectionId === "string" && raw.connectionId.trim()
        ? raw.connectionId.trim()
        : null;
    let capabilityContinuation: BoundCapabilityRequest | null = null;
    if (raw.capabilityContinuation !== undefined && raw.capabilityContinuation !== null) {
      try {
        capabilityContinuation = normalizeBoundCapabilityRequest(raw.capabilityContinuation);
      } catch {
        // error-policy:J3 a malformed signed payload is still invalid input.
        return { ok: false, reason: "malformed" };
      }
    }
    payload = {
      platform: raw.platform.trim().toLowerCase(),
      connectionId,
      organizationId: raw.organizationId.trim(),
      userId: raw.userId.trim(),
      exp: raw.exp,
      nonce: raw.nonce.trim(),
      capabilityContinuation,
    };
  } catch {
    // error-policy:J3 malformed proof payload is an explicit invalid result.
    return { ok: false, reason: "malformed" };
  }

  const organizationId = binding.organizationId.trim();
  const userId = binding.userId.trim();
  if (
    !organizationId ||
    !userId ||
    organizationId !== payload.organizationId ||
    userId !== payload.userId
  ) {
    // Do not consume — the legitimate browser may still present a matching session.
    return { ok: false, reason: "binding_mismatch" };
  }

  let ticket: OAuthSuccessProofTicket | null;
  try {
    ticket = await ticketStore.take(payload.nonce);
  } catch {
    // error-policy:J1 ticket store brownout must not open the gate.
    return { ok: false, reason: "ticket_store_unavailable" };
  }
  if (!ticket) {
    return { ok: false, reason: "already_used" };
  }
  if (
    ticket.organizationId !== payload.organizationId ||
    ticket.userId !== payload.userId ||
    ticket.platform !== payload.platform ||
    (ticket.connectionId ?? null) !== (payload.connectionId ?? null)
  ) {
    return { ok: false, reason: "binding_mismatch" };
  }
  if (ticket.exp < Date.now()) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, payload };
}

/**
 * @deprecated Prefer {@link consumeOAuthSuccessProof}. HMAC-only check without
 * session binding or one-time consume — retained for narrow unit tests of the
 * signature codec only.
 */
export function verifyOAuthSuccessProof(
  proof: string | null | undefined,
): ConsumeOAuthSuccessProofResult {
  const secret = resolveProofSecret();
  if (!secret) return { ok: false, reason: "missing_secret" };
  if (typeof proof !== "string" || !proof.trim()) {
    return { ok: false, reason: "malformed" };
  }
  const trimmed = proof.trim();
  if (trimmed.length > MAX_PROOF_CHARS) {
    return { ok: false, reason: "malformed" };
  }
  const parts = trimmed.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed" };
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return { ok: false, reason: "malformed" };
  const expected = sign(secret, payloadB64);
  if (!safeEqual(expected, signature)) {
    return { ok: false, reason: "bad_signature" };
  }
  try {
    const raw = JSON.parse(
      b64urlDecode(payloadB64).toString("utf8"),
    ) as Partial<OAuthSuccessProofPayload>;
    if (
      typeof raw.platform !== "string" ||
      !raw.platform.trim() ||
      typeof raw.organizationId !== "string" ||
      !raw.organizationId.trim() ||
      typeof raw.userId !== "string" ||
      !raw.userId.trim() ||
      typeof raw.exp !== "number" ||
      !Number.isFinite(raw.exp) ||
      typeof raw.nonce !== "string" ||
      !raw.nonce.trim()
    ) {
      return { ok: false, reason: "malformed" };
    }
    if (raw.exp < Date.now()) return { ok: false, reason: "expired" };
    const connectionId =
      typeof raw.connectionId === "string" && raw.connectionId.trim()
        ? raw.connectionId.trim()
        : null;
    let capabilityContinuation: BoundCapabilityRequest | null = null;
    if (raw.capabilityContinuation !== undefined && raw.capabilityContinuation !== null) {
      try {
        capabilityContinuation = normalizeBoundCapabilityRequest(raw.capabilityContinuation);
      } catch {
        return { ok: false, reason: "malformed" };
      }
    }
    return {
      ok: true,
      payload: {
        platform: raw.platform.trim().toLowerCase(),
        connectionId,
        organizationId: raw.organizationId.trim(),
        userId: raw.userId.trim(),
        exp: raw.exp,
        nonce: raw.nonce.trim(),
        capabilityContinuation,
      },
    };
  } catch {
    // error-policy:J3 malformed proof payload is an explicit invalid result.
    return { ok: false, reason: "malformed" };
  }
}
