/**
 * Wire contract between the Eliza side (gateway + shared agent + plugin-network) and the Network
 * service (docs/design/eliza-conversation-layer.md). Dependency-free so the Cloud copy of this
 * package and the service read the same file. Every request is signed with svc-auth.ts.
 *
 *   POST /internal/turn     Eliza → service   one inbound message on the shared line
 *   POST /api/internal/network/deliver  service → Eliza Cloud  a message the service wants sent
 *        (proactive, relay): delivered through the gateway and appended to the member's agent history
 *   POST /internal/relay    Eliza → service   RELAY action: the member asks to pass something to a match
 *
 * eliza-research/thenetwork keeps a byte-for-byte copy of this file and svc-auth.ts in
 * packages/core/src/svc/. contract-mirror.test.ts pins both files' hashes; see it before changing either.
 */

/** Standalone wire app IDs; mirrors the platform app owner without importing the host. */
export const NETWORK_APP_IDS = ["ntwrk", "slop", "peon", "friends"] as const;
export type NetworkAppId = (typeof NETWORK_APP_IDS)[number];
export type NetworkTransport = "imessage" | "sms" | "rcs" | "unknown";

export const TURN_PATH = "/internal/turn";
export const TURN_RECEIPT_PATH = "/internal/turn-receipt";
export const DELIVER_PATH = "/api/internal/network/deliver";
export const SET_STATE_PATH = "/internal/set-state";
export const SIGNALS_PATH = "/internal/signals";
export const UPDATES_PATH = "/internal/updates";
export const RELAY_PATH = "/internal/relay";

/** Opaque server-selected route identity carried INSIDE the existing signed JSON body.
 * No URL, credential or client-supplied clock grants authority. Receivers separately
 * resolve this tuple against their expected audience, realm and retained route policy.
 */
export interface NetworkRouteAuthorityV1 {
  readonly version: 1;
  readonly routeId: string;
  readonly generation: string;
  readonly audience: string;
  readonly realmId: string;
}

/** Structural validation only; this does not verify a signature or grant admission. */
export function parseNetworkRouteAuthorityV1(
  value: unknown,
): NetworkRouteAuthorityV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const keys = ["version", "routeId", "generation", "audience", "realmId"];
  if (
    Object.keys(record).length !== keys.length ||
    Object.keys(record).some((key) => !keys.includes(key)) ||
    record.version !== 1
  )
    return undefined;
  const boundedId = (input: unknown, limit: number): input is string =>
    typeof input === "string" &&
    input.length <= limit &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(input);
  if (
    !boundedId(record.routeId, 64) ||
    !boundedId(record.generation, 64) ||
    !boundedId(record.audience, 128) ||
    !boundedId(record.realmId, 64)
  )
    return undefined;
  return Object.freeze({
    version: 1,
    routeId: record.routeId,
    generation: record.generation,
    audience: record.audience,
    realmId: record.realmId,
  });
}

export interface TurnRequest {
  /** Optional for legacy production; mandatory and server-verified in isolated realms. */
  networkAuthority?: NetworkRouteAuthorityV1;
  /** The provider message id (Blooio msg_… / Twilio SM…). Idempotency key: a replay returns the stored result and runs nothing. */
  messageId: string;
  channel: "blooio" | "twilio";
  /** Sender, E.164. */
  from: string;
  /** The line it arrived on, E.164 (routes per-app lines). */
  to: string | null;
  text: string;
  transport: NetworkTransport;
  /** ms since epoch, from the provider. */
  receivedAt: number;
  /** Forced app (a per-app line or webhook path); normally absent and the service routes. */
  app?: NetworkAppId;
}

/** What the agent may say about the member in an open turn: shareable, already leak-checked by the service. */
export interface TurnContext {
  firstName: string | null;
  city: string | null;
  state: "open" | "busy" | "traveling" | "paused";
  stateFrom: string | null;
  stateUntil: string | null;
  facets: string[];
  /** Open items (an intro waiting on a yes, a plan), member-safe one-liners. */
  /** null means the canonical owner cannot supply safe summaries; it is not an empty inbox. */
  activeItems: Array<{ id: string; kind: string; summary: string }> | null;
  /** True while the member is a minor: single-player help only, never introductions. */
  singlePlayer: boolean;
}

export type TurnResponse =
  /** The service answered deterministically (STOP, HELP, START, leave, join, looking-for, onboarding, read-back, SHARE, yes/no). Send exactly these; call no model. May be empty (nothing to say, e.g. a held number). */
  | {
      outcome: "handled";
      replies: string[];
      /** Ordered causal output IDs. Collection is not provider acceptance. */
      replyIds: string[];
      delivery: "collected";
      replyKind: "reply" | "compliance";
      /** Canonical policy admission for Cloud account/history, not matching permission. */
      accountEligible: boolean;
      app: NetworkAppId | null;
      memberId: string | null;
      reason: string;
      /** Set when this turn changed carrier consent (STOP / START / leave): the gateway mirrors it into its send-time fence. scope "all" = every app on the line. */
      consent?: {
        state: "opted_out" | "opted_in";
        scope: "all" | "app";
        app: NetworkAppId | null;
        at: number;
      };
    }
  /** Free conversation: the agent replies, with this context and the plugin's actions. */
  | {
      outcome: "open";
      channel: TurnRequest["channel"];
      app: NetworkAppId;
      memberId: string;
      context: TurnContext;
    }
  /** The service will not handle this sender (no network for the app, unknown sender). The agent says nothing Network-specific. */
  | { outcome: "ignored"; reason: string };

/** Gateway acknowledgement of the exact collected outputs for one inbound turn. */
export interface TurnReceiptRequest {
  /** Optional for legacy production; mandatory and server-verified in isolated realms. */
  networkAuthority?: NetworkRouteAuthorityV1;
  channel: TurnRequest["channel"];
  messageId: string;
  replyIds: string[];
  outcome: "accepted" | "unknown" | "rejected";
  providerMessageIds: string[];
  /** True only after the canonical Cloud owner records the accepted message. */
  historyRecorded: boolean;
}

export interface TurnReceiptResponse {
  ok: true;
  replayed: boolean;
}

/** Approved by the service for ONE voluntary item, never a gallery permission or model URL.
 * Structural parsing does not grant consent, review authority or delivery admission.
 */
export interface ApprovedRelayPhoto {
  version: 1;
  app: NetworkAppId;
  itemId: string;
  threadId: string;
  senderMemberId: string;
  recipientMemberId: string;
  photoId: string;
  sha256: string;
  bytes: number;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  consentId: string;
  consentedAt: number;
  reviewId: string;
  reviewedAt: number;
  policyVersion: string;
  expiresAt: number;
}

export const RELAY_PHOTO_RESOLVE_PATH = "/internal/relay-photo/resolve";
export const RELAY_PHOTO_MAX_BYTES = 8 * 1024 * 1024;
export const RELAY_PHOTO_MAX_ITEMS = 3;
export const RELAY_PHOTO_CONSENT_TTL_MS = 15 * 60_000;
export interface RelayPhotoResolveRequest {
  /** Retain the existing server-bound route; never substitutes for route admission. */
  networkAuthority?: NetworkRouteAuthorityV1;
  /** Existing Cloud/Gateway provider intent key; never a new retry namespace. */
  id: string;
  deliveryId: string;
  to: string;
  approvedPhotos: ApprovedRelayPhoto[];
}
export interface RelayPhotoResolveResponse {
  photos: Array<
    Pick<ApprovedRelayPhoto, "photoId" | "sha256" | "bytes" | "contentType"> & {
      /** Only a purpose-separated delivery capability from the trusted service origin. */
      url: string;
    }
  >;
}

/** Strict, normalized immutable identity for hashing; freshness is checked only before a new send.
 * Receipt recovery must still recognize an expired descriptor without dispatching again.
 */
export function parseApprovedRelayPhotos(
  value: unknown,
): ApprovedRelayPhoto[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > RELAY_PHOTO_MAX_ITEMS
  )
    return undefined;
  const keys = [
    "version",
    "app",
    "itemId",
    "threadId",
    "senderMemberId",
    "recipientMemberId",
    "photoId",
    "sha256",
    "bytes",
    "contentType",
    "consentId",
    "consentedAt",
    "reviewId",
    "reviewedAt",
    "policyVersion",
    "expiresAt",
  ];
  const id = (v: unknown): v is string =>
    typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(v);
  const time = (v: unknown): v is number =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  const photos: ApprovedRelayPhoto[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      return undefined;
    const p = entry as Record<string, unknown>;
    if (
      Object.keys(p).length !== keys.length ||
      Object.keys(p).some((k) => !keys.includes(k)) ||
      p.version !== 1 ||
      !NETWORK_APP_IDS.includes(p.app as NetworkAppId)
    )
      return undefined;
    if (
      ![
        p.itemId,
        p.threadId,
        p.senderMemberId,
        p.recipientMemberId,
        p.consentId,
        p.reviewId,
        p.policyVersion,
      ].every(id) ||
      p.senderMemberId === p.recipientMemberId ||
      typeof p.photoId !== "string" ||
      !/^ph_[a-f0-9]{24}$/u.test(p.photoId) ||
      typeof p.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(p.sha256)
    )
      return undefined;
    if (
      typeof p.bytes !== "number" ||
      !Number.isSafeInteger(p.bytes) ||
      p.bytes <= 0 ||
      p.bytes > RELAY_PHOTO_MAX_BYTES ||
      typeof p.contentType !== "string" ||
      !["image/jpeg", "image/png", "image/webp"].includes(p.contentType)
    )
      return undefined;
    if (
      !time(p.consentedAt) ||
      !time(p.reviewedAt) ||
      !time(p.expiresAt) ||
      p.reviewedAt < p.consentedAt ||
      p.expiresAt <= p.reviewedAt ||
      p.expiresAt - p.consentedAt > RELAY_PHOTO_CONSENT_TTL_MS
    )
      return undefined;
    photos.push({
      version: 1,
      app: p.app as NetworkAppId,
      itemId: p.itemId as string,
      threadId: p.threadId as string,
      senderMemberId: p.senderMemberId as string,
      recipientMemberId: p.recipientMemberId as string,
      photoId: p.photoId,
      sha256: p.sha256,
      bytes: p.bytes,
      contentType: p.contentType as ApprovedRelayPhoto["contentType"],
      consentId: p.consentId as string,
      consentedAt: p.consentedAt,
      reviewId: p.reviewId as string,
      reviewedAt: p.reviewedAt,
      policyVersion: p.policyVersion as string,
      expiresAt: p.expiresAt,
    });
  }
  const first = photos[0];
  if (!first) return undefined;
  const shared = keys.filter(
    (k) => !["photoId", "sha256", "bytes", "contentType"].includes(k),
  ) as Array<keyof ApprovedRelayPhoto>;
  if (
    new Set(photos.map((p) => p.photoId)).size !== photos.length ||
    photos.some((p) => shared.some((k) => p[k] !== first[k]))
  )
    return undefined;
  return photos;
}

export interface DeliverRequest {
  /** Server-approved voluntary relay only. No arbitrary media URL is accepted. */
  approvedPhotos?: ApprovedRelayPhoto[];
  /** Mandatory for isolated reply delivery; must match a durably admitted turn. */
  networkParentTurn?: Pick<TurnRequest, "channel" | "messageId">;
  /** Optional for legacy production; mandatory and server-verified in isolated realms. */
  networkAuthority?: NetworkRouteAuthorityV1;
  /** Idempotency key (also x-ntwrk-svc-id). The gateway sends each key at most once. */
  id: string;
  to: string;
  /** Sending line, E.164; absent = the shared line. */
  from?: string | null;
  text: string;
  /** Default "blooio" (the shared line); "twilio" for SMS fallback. */
  channel?: "blooio" | "twilio";
  app: NetworkAppId;
  memberId: string | null;
  /** reply: answer to an inbound; proactive: an intro, reminder or check-in (quiet hours and caps already applied by the service); relay: another member's message, `rendered` only. */
  kind: "reply" | "proactive" | "relay";
}

export type DeliverResponse =
  | {
      ok: true;
      replayed: boolean;
      providerMessageIds: string[];
      /** Verified original acceptance time from the provider receipt owner. */
      acceptedAt: string;
      /** False when the recipient has no Eliza account yet (handled turns only): sent, but not in agent history. */
      history: boolean;
    }
  | {
      ok: false;
      /** opted_out: STOP on the line; unknown: the provider may have it, do not resend blindly. */
      error: "opted_out" | "invalid" | "rejected" | "unknown";
      retryable: boolean;
    };

/**
 * Agent actions in an open turn (all signed, x-ntwrk-svc-id = idempotencyKey or messageId).
 * memberId and app are the service's, from the open TurnResponse; never from model output.
 */
export interface SetStateRequest {
  /** Optional for legacy production; mandatory and server-verified in isolated realms. */
  networkAuthority?: NetworkRouteAuthorityV1;
  messageId: string;
  channel: TurnRequest["channel"];
  idempotencyKey: string;
  app: NetworkAppId;
  memberId: string;
  state: "open" | "busy" | "traveling" | "paused";
  from: string | null;
  until: string | null;
  note: string | null;
}
export interface SetStateResponse {
  /** null when nothing changed (no event written). */
  eventId: string | null;
  previous: SetStateRequest["state"];
  current: SetStateRequest["state"];
  from: string | null;
  until: string | null;
  committedAt: string;
  replayed: boolean;
  unchanged: boolean;
}

export interface SignalsRequest {
  /** Optional for legacy production; mandatory and server-verified in isolated realms. */
  networkAuthority?: NetworkRouteAuthorityV1;
  channel: TurnRequest["channel"];
  messageId: string;
  app: NetworkAppId;
  memberId: string;
  signals: Array<{
    kind: "opt_out" | "travel" | "safety_concern";
    evidence: string;
  }>;
}
export interface SignalsResponse {
  recorded: number;
}

export interface UpdatesRequest {
  /** Optional for legacy production; mandatory and server-verified in isolated realms. */
  networkAuthority?: NetworkRouteAuthorityV1;
  channel: TurnRequest["channel"];
  app: NetworkAppId;
  memberId: string;
  messageId: string;
}
/** Unseen inbox items; reading marks them seen on every surface. Summaries are member-safe. */
export interface UpdatesResponse {
  items: Array<{ summary: string }>;
}

/**
 * RELAY: the member asks the agent to pass something to a match ("tell Sam I'm running late").
 * `text` is the member's own inbound message, never model output: the service parses the request
 * (parseRelayRequest), builds the item and runs relayItemAsync with the relay classifier. Only
 * `rendered` ever reaches the other member, through /api/internal/network/deliver (kind "relay").
 */
export interface RelaySendRequest {
  /** Optional for legacy production; mandatory and server-verified in isolated realms. */
  networkAuthority?: NetworkRouteAuthorityV1;
  channel: TurnRequest["channel"];
  messageId: string;
  app: NetworkAppId;
  memberId: string;
  /** An active item id from the open turn's context; null lets the service pick the newest open item. */
  itemId: string | null;
  text: string;
}
export interface RelaySendResponse {
  /** "none": no relay request in the message (nothing sent). hold: staff review. block: never sent. */
  decision: "pass" | "hold" | "block" | "none";
  /** What the agent tells the sender. Never repeats matched text or names a rule; "" for "none". */
  senderNotice: string;
  /** True once `rendered` was handed to deliver (pass only). */
  delivered: boolean;
  replayed: boolean;
}
