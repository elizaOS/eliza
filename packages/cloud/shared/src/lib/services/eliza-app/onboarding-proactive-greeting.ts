/**
 * Proactive post-link greeting queue for messaging-platform onboarding.
 *
 * When a user starts onboarding in a platform DM (Discord), taps the login
 * CTA, and authenticates in the browser, the messaging conversation goes
 * silent: the platform gateway is request/response and nothing tells the user
 * their sign-in worked. This module records a one-shot "you're all set"
 * greeting at the exact moment a trusted platform session becomes bound to a
 * cloud account from a browser turn. The platform gateway drains the queue and
 * delivers the greeting as a proactive DM.
 *
 * Storage: in Worker deployments the queue lives in a dedicated, well-known
 * Durable Object instance of the onboarding session coordinator
 * (`proactive-greetings:discord`), which gives atomic enqueue (set semantics
 * keyed by session id, so repeated authenticated turns can never duplicate a
 * greeting) and lease/ack delivery. A drain leases entries without deleting
 * them; the gateway acknowledges only delivered or definitively terminal DMs.
 * An unacknowledged lease becomes claimable again after a bounded interval.
 * Each entry also carries a stable Discord nonce so a provider retry is
 * idempotent. Outside a Worker a process-local map provides the same semantics.
 *
 * Failure policy: enqueue failures are logged and swallowed — a missing
 * courtesy greeting must never fail the user's onboarding turn (the sign-in
 * itself already succeeded). Drain failures propagate to the caller (the
 * internal route), which fails closed; unclaimed entries survive for the next
 * poll until they expire.
 *
 * Commit ordering: the onboarding state machine only RECORDS a pending
 * greeting on its result; the caller that owns the turn's durable commit (the
 * session coordinator's storage transaction, or the local store save)
 * enqueues it strictly AFTER that commit. A turn that fails to persist can
 * therefore never produce a "you're all set" DM.
 */

import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { getCloudBinding, hasCloudBindingsContext } from "../../runtime/cloud-bindings";
import { logger } from "../../utils/logger";

const GREETING_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Bound every onboarding coordinator hop so a hung or overloaded Durable
 * Object cannot pin the greeting worker indefinitely. A caller-provided abort
 * signal wins.
 */
export function greetingFetch(
  stub: { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> },
  input: string | URL,
  init?: RequestInit,
  timeoutMs: number = GREETING_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const deadline = AbortSignal.timeout(timeoutMs);
  return stub.fetch(input, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
  });
}

export interface ProactiveGreetingEntry {
  /** Platform-scoped onboarding session id (`platform:discord:<userId>`). */
  sessionId: string;
  /** Discord user id to DM. */
  platformUserId: string;
  /** Server-authored greeting text the gateway delivers verbatim. */
  message: string;
  /** ISO timestamp of enqueue; entries expire after {@link GREETING_TTL_MS}. */
  createdAt: string;
  /** Stable Discord idempotency nonce (the API limit is 25 characters). */
  deliveryNonce: string;
}

export interface LeasedProactiveGreetingEntry extends ProactiveGreetingEntry {
  leaseId: string;
}

export interface ProactiveGreetingAcknowledgement {
  sessionId: string;
  leaseId: string;
}

/**
 * A greeting older than this is stale — the user has either already messaged
 * again (and gotten a live reply) or moved on. Expired entries are dropped at
 * drain time, never delivered.
 */
export const GREETING_TTL_MS = 15 * 60 * 1000;

/** Upper bound on entries returned by a single drain. */
export const MAX_GREETING_DRAIN = 20;

/** Short enough to retry within Discord's enforced-nonce dedupe window. */
export const GREETING_LEASE_MS = 2 * 60 * 1000;

/**
 * Reserved instance-name prefix for the well-known greeting queues. The
 * queues share the ONBOARDING_SESSIONS namespace with per-session
 * coordinators, so session-id validation must refuse to adopt any id under
 * this prefix as a chat session: a chat turn landing on a queue instance
 * would contend its serialize lock and write chat state into queue storage.
 */
export const PROACTIVE_GREETING_QUEUE_PREFIX = "proactive-greetings:";

/** Well-known Durable Object instance name holding the Discord queue. */
export const DISCORD_GREETING_QUEUE_NAME = `${PROACTIVE_GREETING_QUEUE_PREFIX}discord`;

/**
 * Commit-ordering handoff describing a greeting that should enqueue once the
 * turn that produced it has durably persisted.
 */
export interface ProactiveGreetingRequest {
  /** Platform-scoped onboarding session id whose sign-in just completed. */
  sessionId: string;
  /** Discord user id to DM. */
  platformUserId: string;
  /** Preferred name to address in the greeting, when known. */
  name?: string;
}

function greetingCoordinator(): RuntimeDurableObjectNamespace | undefined {
  return getCloudBinding<RuntimeDurableObjectNamespace>("ONBOARDING_SESSIONS");
}

/** Process-local fallback queue for non-Worker runtimes (keyed by session id). */
const localGreetingQueue = new Map<string, ProactiveGreetingEntry>();
const localGreetingLeases = new Map<string, { leaseId: string; expiresAt: number }>();
/** Test-only visibility into the local fallback queue. */
export function peekLocalGreetingQueue(): ProactiveGreetingEntry[] {
  return [...localGreetingQueue.values()];
}

/** Test-only reset of the local fallback queue. */
export function clearLocalGreetingQueue(): void {
  localGreetingQueue.clear();
  localGreetingLeases.clear();
}

function newOpaqueId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 25);
}

export function composeProactiveGreeting(name: string | undefined): string {
  const address = name?.trim() ? `${name.trim()}, ` : "";
  return (
    `${address}you're all set — your account is linked and your agent is spinning up. ` +
    "This chat is yours now: message me anytime and your agent answers."
  );
}

function isEntryFresh(entry: ProactiveGreetingEntry, now: number): boolean {
  const createdAt = Date.parse(entry.createdAt);
  return Number.isFinite(createdAt) && now - createdAt <= GREETING_TTL_MS;
}

/**
 * Records a pending proactive greeting for a freshly bound Discord onboarding
 * session. Never throws: the greeting is a courtesy, the turn is not.
 */
export async function enqueueDiscordProactiveGreeting(
  input: ProactiveGreetingRequest,
): Promise<void> {
  const entry: ProactiveGreetingEntry = {
    sessionId: input.sessionId,
    platformUserId: input.platformUserId,
    message: composeProactiveGreeting(input.name),
    createdAt: new Date().toISOString(),
    deliveryNonce: newOpaqueId(),
  };
  try {
    const coordinator = greetingCoordinator();
    if (coordinator) {
      const response = await greetingFetch(
        coordinator.getByName(DISCORD_GREETING_QUEUE_NAME),
        "https://onboarding.internal/enqueue-greeting",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry),
        },
      );
      if (!response.ok) {
        throw new Error(`greeting enqueue failed (${response.status})`);
      }
      return;
    }
    if (hasCloudBindingsContext()) {
      throw new Error("ONBOARDING_SESSIONS binding is required in Worker deployments");
    }
    const existing = localGreetingQueue.get(entry.sessionId);
    if (!existing) localGreetingQueue.set(entry.sessionId, entry);
  } catch (error) {
    // error-policy:J4 The durable sign-in already succeeded; a queue outage
    // degrades only the explicitly best-effort courtesy greeting.
    logger.warn("[eliza-app onboarding] proactive greeting enqueue failed", {
      sessionId: entry.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Leases up to {@link MAX_GREETING_DRAIN} pending Discord greetings. Entries
 * remain stored until an acknowledgement with the matching lease id arrives.
 */
export async function drainDiscordProactiveGreetings(): Promise<LeasedProactiveGreetingEntry[]> {
  const coordinator = greetingCoordinator();
  if (coordinator) {
    const response = await greetingFetch(
      coordinator.getByName(DISCORD_GREETING_QUEUE_NAME),
      "https://onboarding.internal/drain-greetings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: MAX_GREETING_DRAIN }),
      },
    );
    if (!response.ok) {
      throw new Error(`greeting drain failed (${response.status})`);
    }
    const body = (await response.json()) as {
      greetings?: LeasedProactiveGreetingEntry[];
    };
    return body.greetings ?? [];
  }
  if (hasCloudBindingsContext()) {
    throw new Error("ONBOARDING_SESSIONS binding is required in Worker deployments");
  }
  const now = Date.now();
  const claimed: LeasedProactiveGreetingEntry[] = [];
  for (const [key, entry] of localGreetingQueue) {
    if (claimed.length >= MAX_GREETING_DRAIN) break;
    if (!isEntryFresh(entry, now)) {
      localGreetingQueue.delete(key);
      localGreetingLeases.delete(key);
      logger.warn("[eliza-app onboarding] dropped expired proactive greeting", {
        sessionId: entry.sessionId,
      });
      continue;
    }
    const currentLease = localGreetingLeases.get(key);
    if (currentLease && currentLease.expiresAt > now) continue;
    const leaseId = newOpaqueId();
    localGreetingLeases.set(key, {
      leaseId,
      expiresAt: now + GREETING_LEASE_MS,
    });
    claimed.push({ ...entry, leaseId });
  }
  return claimed;
}

/** Deletes only greetings whose current lease matches the acknowledgement. */
export async function acknowledgeDiscordProactiveGreetings(
  acknowledgements: ProactiveGreetingAcknowledgement[],
): Promise<number> {
  const coordinator = greetingCoordinator();
  if (coordinator) {
    const response = await greetingFetch(
      coordinator.getByName(DISCORD_GREETING_QUEUE_NAME),
      "https://onboarding.internal/ack-greetings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ acknowledgements }),
      },
    );
    if (!response.ok) {
      throw new Error(`greeting acknowledgement failed (${response.status})`);
    }
    const body = (await response.json()) as { acknowledged?: number };
    return body.acknowledged ?? 0;
  }
  if (hasCloudBindingsContext()) {
    throw new Error("ONBOARDING_SESSIONS binding is required in Worker deployments");
  }
  let acknowledged = 0;
  for (const acknowledgement of acknowledgements) {
    const lease = localGreetingLeases.get(acknowledgement.sessionId);
    if (lease?.leaseId !== acknowledgement.leaseId) continue;
    localGreetingQueue.delete(acknowledgement.sessionId);
    localGreetingLeases.delete(acknowledgement.sessionId);
    acknowledged += 1;
  }
  return acknowledged;
}
