/**
 * Carrier keyword handling (STOP / START / HELP), the consent ledger, and the
 * Twilio reply idempotency fence for The Network's `network` project.
 *
 * Everything here is gated on `project === "network"`; Eliza projects never
 * reach it, so their behaviour is unchanged.
 *
 * Rules (ported from the Network messaging prototype, CTIA conventions):
 *  - Exact keyword match after normalization ("stop", "STOP!", " Stop. "),
 *    so ordinary conversation ("stop by later") is never read as an opt-out.
 *  - Opt-out takes effect before the confirmation is sent; every later send to
 *    that address (inbound replies and /internal/deliver) is refused, so STOP
 *    halts sends within one message: the confirmation is the last one.
 *  - "YES" is deliberately not an opt-in keyword.
 *  - HELP is answered even for an opted-out address.
 *  - Nothing is ever posted into a group; a keyword there only updates the
 *    sender's ledger entry.
 */

import type { ChatEvent, Platform } from "./adapters/types";
import type { GatewayRedis } from "./redis";

export const NETWORK_PROJECT = "network";

export function isNetworkProject(project: string | undefined | null): boolean {
  return project?.trim().toLowerCase() === NETWORK_PROJECT;
}

export const STOP_WORDS = [
  "STOP",
  "STOPALL",
  "STOP ALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  "REVOKE",
  "OPTOUT",
  "OPT OUT",
];
export const START_WORDS = ["START", "UNSTOP", "SUBSCRIBE", "RESUME"];
export const HELP_WORDS = ["HELP", "INFO"];

export type NetworkKeywordAction = "opt_out" | "opt_in" | "help";

export const NETWORK_KEYWORD_COPY = {
  optOut:
    "You're unsubscribed from The Network and won't get more messages here. Reply START to resume.",
  optIn:
    "You're back on The Network. Reply STOP anytime to opt out, HELP for help.",
  help: "The Network: invite-only messages about people, plans, and events you asked for. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out. Help: help@ntwrk.love",
} as const;

export function normalizeKeyword(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function detectNetworkKeyword(
  text: string | undefined,
): NetworkKeywordAction | null {
  const keyword = normalizeKeyword(text ?? "");
  if (!keyword) return null;
  if (STOP_WORDS.includes(keyword)) return "opt_out";
  if (START_WORDS.includes(keyword)) return "opt_in";
  if (HELP_WORDS.includes(keyword)) return "help";
  return null;
}

export interface NetworkConsentEntry {
  project: string;
  channel: Platform;
  address: string;
  state: "opted_in" | "opted_out";
  /** `keyword:STOP`, `keyword:START`, `invite_acceptance`, `admin`, ... */
  source: string;
  providerMessageId?: string;
  at: string;
}

/**
 * Durable sink for consent changes (Postgres `network.consent_ledger` through
 * Cloud's internal API). Writes must be idempotent per provider message id.
 */
export interface NetworkConsentSink {
  write(entry: NetworkConsentEntry): Promise<void>;
}

export const NETWORK_CONSENT_OUTBOX_KEY = "network-consent-outbox";

/** POSTs consent entries to Cloud's `/api/internal/network/consent`. */
export function cloudNetworkConsentSink(deps: {
  cloudBaseUrl: string;
  getAuthHeader: () => Record<string, string>;
  reacquireAuthHeader?: () => Promise<Record<string, string>>;
  fetchImpl?: typeof fetch;
}): NetworkConsentSink {
  return {
    async write(entry) {
      const doFetch = deps.fetchImpl ?? fetch;
      const post = (headers: Record<string, string>) =>
        doFetch(`${deps.cloudBaseUrl}/api/internal/network/consent`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(entry),
          signal: AbortSignal.timeout(10_000),
        });
      let response = await post(deps.getAuthHeader());
      if (
        (response.status === 401 || response.status === 403) &&
        deps.reacquireAuthHeader
      ) {
        await response.body?.cancel();
        response = await post(await deps.reacquireAuthHeader());
      }
      await response.body?.cancel();
      if (!response.ok) {
        throw new Error(`consent ledger write failed (${response.status})`);
      }
    },
  };
}

/**
 * Retry durable writes that failed earlier. Entries are idempotent at the
 * sink, so at-least-once replay is safe. Stops at the first failure and puts
 * that entry back. Returns how many entries were written.
 */
export async function drainNetworkConsentOutbox(
  redis: GatewayRedis,
  sink: NetworkConsentSink,
  max = 50,
): Promise<number> {
  let written = 0;
  for (let index = 0; index < max; index++) {
    const value = await redis.rpop(NETWORK_CONSENT_OUTBOX_KEY);
    if (value === null || value === undefined) break;
    const entry = parseConsentEntry(value);
    if (!entry) continue;
    try {
      await sink.write(entry);
      written += 1;
    } catch {
      // error-policy:J6 keep the entry for the next drain; Redis still
      // enforces the consent state meanwhile.
      await redis.lpush(NETWORK_CONSENT_OUTBOX_KEY, JSON.stringify(entry));
      break;
    }
  }
  return written;
}

/** Current consent state per (project, address), plus an append-only history. */
export interface NetworkConsentLedger {
  current(
    project: string,
    address: string,
  ): Promise<NetworkConsentEntry | null>;
  record(entry: NetworkConsentEntry): Promise<void>;
}

const CONSENT_HISTORY_LIMIT = 200;

/** Addresses are phone numbers or handles; case and whitespace never matter. */
export function consentAddress(address: string): string {
  return address.trim().toLowerCase();
}

function parseConsentEntry(value: unknown): NetworkConsentEntry | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      // error-policy:J3 an unreadable ledger row is treated as no consent row.
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object") return null;
  const entry = candidate as Record<string, unknown>;
  if (
    typeof entry.project !== "string" ||
    typeof entry.address !== "string" ||
    (entry.state !== "opted_in" && entry.state !== "opted_out") ||
    typeof entry.source !== "string" ||
    typeof entry.at !== "string"
  ) {
    return null;
  }
  return entry as unknown as NetworkConsentEntry;
}

/**
 * Redis-backed ledger. The current-state key has no TTL (consent must not
 * silently expire); the history list keeps the latest entries per address.
 * Postgres `network.consent_ledger` (migration 0474) is the durable audit copy.
 */
export function redisNetworkConsentLedger(
  redis: GatewayRedis,
  durable?: NetworkConsentSink,
): NetworkConsentLedger {
  const currentKey = (project: string, address: string) =>
    `network-consent:${project}:${consentAddress(address)}`;
  const historyKey = (project: string, address: string) =>
    `network-consent-log:${project}:${consentAddress(address)}`;
  return {
    async current(project, address) {
      return parseConsentEntry(
        await redis.get<unknown>(currentKey(project, address)),
      );
    },
    async record(entry) {
      const normalized = { ...entry, address: consentAddress(entry.address) };
      const serialized = JSON.stringify(normalized);
      // State first: once this write lands every later send is refused, even
      // if the audit append below fails.
      await redis.set(currentKey(entry.project, entry.address), serialized);
      await redis.lpush(historyKey(entry.project, entry.address), serialized);
      await redis.ltrim(
        historyKey(entry.project, entry.address),
        0,
        CONSENT_HISTORY_LIMIT - 1,
      );
      if (!durable) return;
      // Durable copy after the fast path. A failure is queued, never thrown:
      // the opt-out is already enforced, and the confirmation must still go out.
      try {
        await durable.write(normalized);
        await drainNetworkConsentOutbox(redis, durable, 10);
      } catch {
        // error-policy:J6 queued for drainNetworkConsentOutbox (interval + next write).
        await redis.lpush(NETWORK_CONSENT_OUTBOX_KEY, serialized);
      }
    },
  };
}

export async function isNetworkAddressOptedOut(
  ledger: NetworkConsentLedger,
  project: string,
  address: string,
): Promise<boolean> {
  return (await ledger.current(project, address))?.state === "opted_out";
}

export type NetworkInboundCompliance =
  /** Send this canned text instead of running a turn. */
  | { kind: "reply"; action: NetworkKeywordAction; text: string }
  /** Run no turn and send nothing. */
  | {
      kind: "suppress";
      reason: "opted_out" | "group_keyword";
      action?: NetworkKeywordAction;
    }
  /** Not a keyword and not opted out: continue to the agent. */
  | { kind: "continue" };

/**
 * Apply carrier keywords before any agent work. Non-network projects always
 * get `continue` without a ledger read.
 */
export async function handleNetworkInboundCompliance(
  ledger: NetworkConsentLedger,
  project: string,
  event: ChatEvent,
  now: () => Date = () => new Date(),
): Promise<NetworkInboundCompliance> {
  if (!isNetworkProject(project) || event.membershipChange) {
    return { kind: "continue" };
  }
  const isGroup = event.chatType === "group" || event.chatType === "supergroup";
  const action = detectNetworkKeyword(event.text);
  if (action === "opt_out" || action === "opt_in") {
    await ledger.record({
      project,
      channel: event.platform,
      address: event.senderId,
      state: action === "opt_out" ? "opted_out" : "opted_in",
      source: `keyword:${normalizeKeyword(event.text)}`,
      providerMessageId: event.messageId,
      at: now().toISOString(),
    });
    if (isGroup) return { kind: "suppress", reason: "group_keyword", action };
    return {
      kind: "reply",
      action,
      text:
        action === "opt_out"
          ? NETWORK_KEYWORD_COPY.optOut
          : NETWORK_KEYWORD_COPY.optIn,
    };
  }
  if (action === "help") {
    return isGroup
      ? { kind: "suppress", reason: "group_keyword", action }
      : { kind: "reply", action, text: NETWORK_KEYWORD_COPY.help };
  }
  if (await isNetworkAddressOptedOut(ledger, project, event.senderId)) {
    return { kind: "suppress", reason: "opted_out" };
  }
  return { kind: "continue" };
}

const REPLY_FENCE_TTL_SECONDS = 14 * 24 * 60 * 60;

/**
 * Twilio has no provider-side idempotency key, so a reopened webhook could
 * send the same reply twice. This is the `/internal/deliver` tombstone pattern
 * applied to inbound replies: claim `reply:twilio:<project>:<messageId>` with
 * SET NX as `indeterminate` before egress, replace it with `complete` after a
 * provider receipt, and release it only on an explicit provider rejection.
 */
export async function sendWithTwilioReplyFence(
  redis: GatewayRedis,
  project: string,
  messageId: string,
  send: () => Promise<string[]>,
  isExplicitRejection: (error: unknown) => boolean,
): Promise<"sent" | "replayed"> {
  const key = `reply:twilio:${project}:${messageId}`;
  const claimed = await redis.set(key, "indeterminate", {
    nx: true,
    ex: REPLY_FENCE_TTL_SECONDS,
  });
  if (claimed === null) return "replayed";
  try {
    const providerMessageIds = (await send()) ?? [];
    await redis.set(
      key,
      JSON.stringify({ state: "complete", providerMessageIds }),
      { ex: REPLY_FENCE_TTL_SECONDS },
    );
    return "sent";
  } catch (error) {
    if (isExplicitRejection(error)) {
      try {
        await redis.del(key);
      } catch {
        // error-policy:J6 the tombstone outlives a lost release; the provider
        // rejection below remains the primary outcome.
      }
    }
    throw error;
  }
}
