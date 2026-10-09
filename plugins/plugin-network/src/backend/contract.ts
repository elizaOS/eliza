/**
 * Wire contract between the Eliza side (gateway + shared agent + plugin-network) and the Network
 * service (eliza-research/thenetwork, docs/design/eliza-conversation-layer.md). Dependency-free:
 * the service keeps a byte-for-byte mirror of this file. Every request is signed with svc-auth.ts.
 *
 *   POST /internal/turn     Eliza → service   one inbound message on the shared line
 *   POST /api/internal/network/deliver  service → Eliza Cloud  a message the service wants sent
 *        (proactive, relay): delivered through the gateway and appended to the member's agent history
 */

/** Mirrors APP_IDS in packages/platform/src/apps.ts (kept literal: this file has no imports). */
export type NetworkAppId = "ntwrk" | "slop" | "peon" | "friends";
export type NetworkTransport = "imessage" | "sms" | "rcs" | "unknown";

/**
 * Contract version. This file and svc-auth.ts are mirrored byte-for-byte in eliza-research/thenetwork
 * (packages/core/src/svc/); bump this on any wire change and update both copies together.
 */
export const CONTRACT_VERSION = "2026-10-08.1";

export const TURN_PATH = "/internal/turn";
export const DELIVER_PATH = "/api/internal/network/deliver";
export const SET_STATE_PATH = "/internal/set-state";
export const SIGNALS_PATH = "/internal/signals";
export const UPDATES_PATH = "/internal/updates";

export interface TurnRequest {
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
  activeItems: Array<{ id: string; kind: string; summary: string }>;
  /** True while the member is a minor: single-player help only, never introductions. */
  singlePlayer: boolean;
}

export type TurnResponse =
  /** The service answered deterministically (STOP, HELP, START, leave, join, looking-for, onboarding, read-back, SHARE, yes/no). Send exactly these; call no model. May be empty (nothing to say, e.g. a held number). */
  | {
      outcome: "handled"; replies: string[]; app: NetworkAppId | null; memberId: string | null; reason: string;
      /** Set when this turn changed carrier consent (STOP / START / leave): the gateway mirrors it into its send-time fence. scope "all" = every app on the line. */
      consent?: { state: "opted_out" | "opted_in"; scope: "all" | "app" };
    }
  /** Free conversation: the agent replies, with this context and the plugin's actions. */
  | { outcome: "open"; app: NetworkAppId; memberId: string; context: TurnContext }
  /** The service will not handle this sender (no network for the app, unknown sender). The agent says nothing Network-specific. */
  | { outcome: "ignored"; reason: string };

export interface DeliverRequest {
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
  messageId: string;
  app: NetworkAppId;
  memberId: string;
  signals: Array<{ kind: "opt_out" | "travel" | "safety_concern"; evidence: string }>;
}
export interface SignalsResponse { recorded: number }

export interface UpdatesRequest { app: NetworkAppId; memberId: string; messageId: string }
/** Unseen inbox items; reading marks them seen on every surface. Summaries are member-safe. */
export interface UpdatesResponse { items: Array<{ summary: string }> }
