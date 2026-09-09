/**
 * Short-lived server-issued review snapshots, not lifecycle authorization.
 * An accepted action still needs current authentication and the canonical
 * transactional target/job/economics fences. A cache miss never recreates a
 * review from client data, and reading a review never extends its lifetime.
 */
import type { AuthResult } from "../auth";
import { type CacheReadOutcome, type CacheWriteOutcome, cache } from "../cache/client";
import { CacheKeys } from "../cache/keys";

export const DEDICATED_REVIEW_LIFETIME_MS = 5 * 60 * 1000;
const HASH = /^[a-f0-9]{64}$/;

export interface DedicatedReviewRecord {
  version: 1;
  quoteId: string;
  binding: string;
  termsId: string;
  issuedAt: number;
  expiresAt: number;
}

type ReviewAuthentication = Pick<AuthResult, "authMethod" | "session_token"> & {
  user: Pick<AuthResult["user"], "id" | "organization_id">;
  apiKey?: Pick<NonNullable<AuthResult["apiKey"]>, "id">;
};

interface ReviewStore {
  read(key: string): Promise<CacheReadOutcome<unknown>>;
  write(key: string, value: DedicatedReviewRecord, ttlSeconds: number): Promise<CacheWriteOutcome>;
}

async function digest(parts: string[]): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Only pass the result of canonical authentication, never raw request headers. */
export async function dedicatedReviewBinding(
  auth: ReviewAuthentication,
  sourceAgentId: string,
): Promise<string> {
  let credential: string;
  switch (auth.authMethod) {
    case "session":
      if (!auth.session_token) throw new Error("Dedicated review requires a current session");
      credential = auth.session_token;
      break;
    case "api_key":
      if (!auth.apiKey?.id) throw new Error("Dedicated review requires a current API key");
      credential = auth.apiKey.id;
      break;
    case "wallet_signature":
      // Wallet request signatures are reverified per request, not sessions.
      // Bind their canonical account and auth method, never a replayable signature.
      credential = "verified-wallet-request";
      break;
    default:
      throw new Error("Dedicated review requires a supported authentication method");
  }
  if (!auth.user.id || !auth.user.organization_id || !sourceAgentId) {
    throw new Error("Dedicated review requires an account, organization and source");
  }
  return digest([
    "dedicated-review-v1",
    auth.authMethod,
    auth.user.organization_id,
    auth.user.id,
    sourceAgentId,
    credential,
  ]);
}

function validRecord(value: unknown): value is DedicatedReviewRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.version === 1 &&
    typeof record.quoteId === "string" &&
    HASH.test(record.quoteId) &&
    typeof record.binding === "string" &&
    HASH.test(record.binding) &&
    typeof record.termsId === "string" &&
    HASH.test(record.termsId) &&
    typeof record.issuedAt === "number" &&
    Number.isSafeInteger(record.issuedAt) &&
    record.issuedAt > 0 &&
    typeof record.expiresAt === "number" &&
    Number.isSafeInteger(record.expiresAt) &&
    record.expiresAt - record.issuedAt === DEDICATED_REVIEW_LIFETIME_MS
  );
}

export function isDedicatedReviewCurrent(review: DedicatedReviewRecord, now = Date.now()): boolean {
  return (
    validRecord(review) &&
    Number.isSafeInteger(now) &&
    now >= review.issuedAt &&
    now < review.expiresAt
  );
}

export class DedicatedActivationReviews {
  constructor(
    private readonly store: ReviewStore,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async issue(binding: string, termsId: string): Promise<DedicatedReviewRecord> {
    if (!HASH.test(binding) || !HASH.test(termsId))
      throw new Error("Invalid Dedicated review scope");
    const issuedAt = this.now();
    const quoteId = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const record: DedicatedReviewRecord = {
      version: 1,
      quoteId,
      binding,
      termsId,
      issuedAt,
      expiresAt: issuedAt + DEDICATED_REVIEW_LIFETIME_MS,
    };
    if (!validRecord(record)) throw new Error("Invalid Dedicated review clock");
    // Unique keys are never refreshed/overwritten: eventual-cache misses fail
    // closed, while retained values still obey their embedded server deadline.
    const result = await this.store.write(
      CacheKeys.dedicatedReview.quote(quoteId),
      record,
      DEDICATED_REVIEW_LIFETIME_MS / 1000,
    );
    if (result.kind !== "written" || !isDedicatedReviewCurrent(record, this.now())) {
      throw new Error("Dedicated review could not be issued");
    }
    return { ...record };
  }

  async resolve(quoteId: string, binding: string): Promise<DedicatedReviewRecord | null> {
    if (!HASH.test(quoteId) || !HASH.test(binding)) return null;
    const result = await this.store.read(CacheKeys.dedicatedReview.quote(quoteId));
    if (result.kind !== "hit" || !validRecord(result.value)) return null;
    const record = result.value;
    if (
      record.quoteId !== quoteId ||
      record.binding !== binding ||
      !isDedicatedReviewCurrent(record, this.now())
    )
      return null;
    return { ...record };
  }
}

export const dedicatedActivationReviews = new DedicatedActivationReviews({
  read: (key) => cache.getWithOutcome<unknown>(key, { keyClass: "dedicated_review" }),
  write: (key, value, ttl) =>
    cache.setWithOutcome(key, value, ttl, { keyClass: "dedicated_review" }),
});
