/**
 * Cloudflare-Workers-compatible Web Push sender.
 *
 * Signs a VAPID JWT (ES256), encrypts the payload with aes128gcm, and POSTs to
 * the subscription endpoint using the global `fetch`. On a `404`/`410 Gone`
 * response the subscription is reported dead so the caller can PRUNE it.
 *
 * No Node `crypto`, no `Buffer`, no `web-push` npm package — this whole path
 * runs unmodified on Cloudflare Workers.
 */

import { encryptWebPushPayload, type PushSubscriptionKeys } from "./encrypt";
import { buildVapidAuthHeader, pushEndpointAudience, signVapidJwt } from "./vapid";

/** The subscription shape the browser's `PushSubscription.toJSON()` produces. */
export interface StoredPushSubscription {
  endpoint: string;
  keys: PushSubscriptionKeys;
}

export interface WebPushVapidConfig {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or https contact URI for the VAPID `sub` claim. */
  subject: string;
}

/** Notification payload the SW `push` handler understands (mirrors sw-push.js). */
export interface WebPushNotificationPayload {
  title: string;
  body: string;
  /** Coalescing tag — one bubble per conversation. */
  tag?: string;
  conversationId?: string;
  agentId?: string;
  deepLink?: string;
  /** App-badge count set via `navigator.setAppBadge` on receipt. */
  badgeCount?: number;
  icon?: string;
}

export type WebPushSendOutcome =
  | { ok: true; status: number }
  /** The endpoint is gone (404/410) — the caller MUST prune this subscription. */
  | { ok: false; gone: true; status: number; error?: string }
  /** Transient/other failure — keep the subscription, may retry later. */
  | { ok: false; gone: false; status: number; error?: string };

export interface SendDeps {
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock passed through to JWT signing. */
  now?: () => number;
  /** TTL header value (seconds the push service should retain). */
  ttlSeconds?: number;
  /** Urgency: very-low|low|normal|high (RFC 8030 §5.3). */
  urgency?: "very-low" | "low" | "normal" | "high";
}

const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h

/** True for the HTTP statuses that mean "this subscription no longer exists". */
export function isGoneStatus(status: number): boolean {
  return status === 404 || status === 410;
}

/**
 * Send one Web Push message to one subscription.
 *
 * Returns a structured outcome; `gone: true` signals the subscription should be
 * pruned by the caller (see `sendWebPushBatch`).
 */
export async function sendWebPush(
  subscription: StoredPushSubscription,
  payload: WebPushNotificationPayload,
  vapid: WebPushVapidConfig,
  deps: SendDeps = {},
): Promise<WebPushSendOutcome> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const ttl = deps.ttlSeconds ?? DEFAULT_TTL_SECONDS;

  let audience: string;
  try {
    audience = pushEndpointAudience(subscription.endpoint);
  } catch {
    // A malformed endpoint can never be delivered to; treat as gone so it prunes.
    return { ok: false, gone: true, status: 400, error: "invalid endpoint" };
  }

  const jwt = await signVapidJwt({
    audience,
    subject: vapid.subject,
    privateKey: vapid.privateKey,
    publicKey: vapid.publicKey,
    ...(deps.now ? { now: deps.now } : {}),
  });

  const { body } = await encryptWebPushPayload(JSON.stringify(payload), subscription.keys);

  const headers: Record<string, string> = {
    Authorization: buildVapidAuthHeader(jwt, vapid.publicKey),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(ttl),
    Urgency: deps.urgency ?? "normal",
  };

  let response: Response;
  try {
    response = await fetchImpl(subscription.endpoint, {
      method: "POST",
      headers,
      body: body as BodyInit,
    });
  } catch (error) {
    return {
      ok: false,
      gone: false,
      status: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (response.status >= 200 && response.status < 300) {
    return { ok: true, status: response.status };
  }
  if (isGoneStatus(response.status)) {
    return { ok: false, gone: true, status: response.status };
  }
  return {
    ok: false,
    gone: false,
    status: response.status,
    error: `push endpoint returned ${response.status}`,
  };
}

export interface BatchSendResult {
  sent: number;
  failed: number;
  /** Endpoints that returned 404/410 and should be deleted from the store. */
  goneEndpoints: string[];
}

/**
 * Send the same payload to many subscriptions (e.g. all of a user's installed
 * PWAs) and collect the endpoints that must be pruned. The caller deletes the
 * `goneEndpoints` from the subscription store.
 */
export async function sendWebPushBatch(
  subscriptions: StoredPushSubscription[],
  payload: WebPushNotificationPayload,
  vapid: WebPushVapidConfig,
  deps: SendDeps = {},
): Promise<BatchSendResult> {
  const results = await Promise.all(
    subscriptions.map(async (sub) => ({
      endpoint: sub.endpoint,
      outcome: await sendWebPush(sub, payload, vapid, deps),
    })),
  );

  const goneEndpoints: string[] = [];
  let sent = 0;
  let failed = 0;
  for (const { endpoint, outcome } of results) {
    if (outcome.ok) {
      sent += 1;
    } else {
      failed += 1;
      if (outcome.gone) goneEndpoints.push(endpoint);
    }
  }
  return { sent, failed, goneEndpoints };
}
