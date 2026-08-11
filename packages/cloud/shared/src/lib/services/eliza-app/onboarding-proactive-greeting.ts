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
 * greeting) and atomic drain (claimed entries are deleted in the same
 * serialized operation — single consumer, at-most-once delivery). Outside a
 * Worker (tests, local node runs) a process-local map provides the same
 * semantics.
 *
 * Failure policy: enqueue failures are logged and swallowed — a missing
 * courtesy greeting must never fail the user's onboarding turn (the sign-in
 * itself already succeeded). Drain failures propagate to the caller (the
 * internal route), which fails closed; unclaimed entries survive for the next
 * poll until they expire.
 */

import type { RuntimeDurableObjectNamespace } from "../../../types/cloud-worker-env";
import { getCloudBinding, hasCloudBindingsContext } from "../../runtime/cloud-bindings";
import { logger } from "../../utils/logger";

export interface ProactiveGreetingEntry {
  /** Platform-scoped onboarding session id (`platform:discord:<userId>`). */
  sessionId: string;
  /** Discord user id to DM. */
  platformUserId: string;
  /** Server-authored greeting text the gateway delivers verbatim. */
  message: string;
  /** ISO timestamp of enqueue; entries expire after {@link GREETING_TTL_MS}. */
  createdAt: string;
}

/**
 * A greeting older than this is stale — the user has either already messaged
 * again (and gotten a live reply) or moved on. Expired entries are dropped at
 * drain time, never delivered.
 */
export const GREETING_TTL_MS = 15 * 60 * 1000;

/** Upper bound on entries returned by a single drain. */
export const MAX_GREETING_DRAIN = 20;

/** Well-known Durable Object instance name holding the Discord queue. */
export const DISCORD_GREETING_QUEUE_NAME = "proactive-greetings:discord";

function greetingCoordinator(): RuntimeDurableObjectNamespace | undefined {
  return getCloudBinding<RuntimeDurableObjectNamespace>("ONBOARDING_SESSIONS");
}

/** Process-local fallback queue for non-Worker runtimes (keyed by session id). */
const localGreetingQueue = new Map<string, ProactiveGreetingEntry>();

/** Test-only visibility into the local fallback queue. */
export function peekLocalGreetingQueue(): ProactiveGreetingEntry[] {
  return [...localGreetingQueue.values()];
}

/** Test-only reset of the local fallback queue. */
export function clearLocalGreetingQueue(): void {
  localGreetingQueue.clear();
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
export async function enqueueDiscordProactiveGreeting(input: {
  sessionId: string;
  platformUserId: string;
  name?: string;
}): Promise<void> {
  const entry: ProactiveGreetingEntry = {
    sessionId: input.sessionId,
    platformUserId: input.platformUserId,
    message: composeProactiveGreeting(input.name),
    createdAt: new Date().toISOString(),
  };
  try {
    const coordinator = greetingCoordinator();
    if (coordinator) {
      const response = await coordinator
        .getByName(DISCORD_GREETING_QUEUE_NAME)
        .fetch("https://onboarding.internal/enqueue-greeting", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry),
        });
      if (!response.ok) {
        throw new Error(`greeting enqueue failed (${response.status})`);
      }
      return;
    }
    if (hasCloudBindingsContext()) {
      throw new Error("ONBOARDING_SESSIONS binding is required in Worker deployments");
    }
    localGreetingQueue.set(entry.sessionId, entry);
  } catch (error) {
    // error-policy: the proactive greeting is best-effort by design; a queue
    // outage must not turn a successful sign-in into a failed onboarding turn.
    logger.warn("[eliza-app onboarding] proactive greeting enqueue failed", {
      sessionId: entry.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Claims up to {@link MAX_GREETING_DRAIN} pending Discord greetings. Claimed
 * entries are removed atomically (at-most-once delivery); expired entries are
 * dropped with a log line and never returned.
 */
export async function drainDiscordProactiveGreetings(): Promise<ProactiveGreetingEntry[]> {
  const coordinator = greetingCoordinator();
  if (coordinator) {
    const response = await coordinator
      .getByName(DISCORD_GREETING_QUEUE_NAME)
      .fetch("https://onboarding.internal/drain-greetings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: MAX_GREETING_DRAIN }),
      });
    if (!response.ok) {
      throw new Error(`greeting drain failed (${response.status})`);
    }
    const body = (await response.json()) as { greetings?: ProactiveGreetingEntry[] };
    return body.greetings ?? [];
  }
  if (hasCloudBindingsContext()) {
    throw new Error("ONBOARDING_SESSIONS binding is required in Worker deployments");
  }
  const now = Date.now();
  const claimed: ProactiveGreetingEntry[] = [];
  for (const [key, entry] of localGreetingQueue) {
    if (claimed.length >= MAX_GREETING_DRAIN) break;
    localGreetingQueue.delete(key);
    if (!isEntryFresh(entry, now)) {
      logger.warn("[eliza-app onboarding] dropped expired proactive greeting", {
        sessionId: entry.sessionId,
      });
      continue;
    }
    claimed.push(entry);
  }
  return claimed;
}
