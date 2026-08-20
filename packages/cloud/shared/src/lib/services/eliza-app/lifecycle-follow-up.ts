/**
 * Turns authoritative account lifecycle completions into durable, concise
 * follow-ups on a verified messaging identity owned by the same cloud user.
 */

import type { AgentCapabilityId } from "@elizaos/shared";
import { usersRepository } from "../../../db/repositories/users";
import type { User } from "../../../db/schemas/users";
import {
  enqueueProactiveLifecycleMessage,
  type ProactiveGreetingPlatform,
  type ProactiveLifecycleEventKind,
  type ProactiveLifecycleEventMetadata,
} from "./onboarding-proactive-greeting";

export type LifecycleEventOrigin = "web" | "app" | ProactiveGreetingPlatform;

export interface LifecycleCapabilityContinuation {
  originalIntent: string;
  capabilityId: AgentCapabilityId;
  clientMessageId?: string;
  /** Lifecycle notices can offer to resume, but never authorize an effect. */
  requiresConfirmation: true;
}

/** Matches the canonical onboarding/chat message boundary. */
export const LIFECYCLE_CONTINUATION_INTENT_MAX_LENGTH = 4_000;
export const LIFECYCLE_CONTINUATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface StoredLifecycleCapabilityContinuation {
  expiresAt: number;
  continuation: LifecycleCapabilityContinuation;
}

export function createStoredLifecycleCapabilityContinuation(
  continuation: LifecycleCapabilityContinuation,
  now: () => number = Date.now,
): StoredLifecycleCapabilityContinuation {
  return {
    expiresAt: now() + LIFECYCLE_CONTINUATION_TTL_MS,
    continuation,
  };
}

export function parseStoredLifecycleCapabilityContinuation(
  value: unknown,
  now: () => number = Date.now,
): LifecycleCapabilityContinuation | null {
  return readStoredLifecycleCapabilityContinuation(value, now)?.continuation ?? null;
}

export function readStoredLifecycleCapabilityContinuation(
  value: unknown,
  now: () => number = Date.now,
): StoredLifecycleCapabilityContinuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Record<string, unknown>;
  if (
    typeof stored.expiresAt !== "number" ||
    !Number.isFinite(stored.expiresAt) ||
    stored.expiresAt < now()
  ) {
    return null;
  }
  const continuation = parseLifecycleCapabilityContinuation(stored.continuation);
  return continuation ? { expiresAt: stored.expiresAt, continuation } : null;
}

const CAPABILITY_IDS = new Set<AgentCapabilityId>([
  "conversation",
  "drafting",
  "web-search",
  "reminders",
  "todos",
  "image-generation",
  "calendar",
  "bookings",
  "communications",
  "purchases",
  "notes",
  "cloud-apps",
  "coding-runtime",
  "shell",
  "filesystem",
  "browser-control",
  "profile-memory",
]);

/** Validates the only user-authored payload allowed into a lifecycle notice. */
export function parseLifecycleCapabilityContinuation(
  value: unknown,
): LifecycleCapabilityContinuation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const originalIntent =
    typeof input.originalIntent === "string" ? input.originalIntent.trim() : "";
  const capabilityId = typeof input.capabilityId === "string" ? input.capabilityId.trim() : "";
  const clientMessageId =
    typeof input.clientMessageId === "string" ? input.clientMessageId.trim() : undefined;
  if (
    !originalIntent ||
    originalIntent.length > LIFECYCLE_CONTINUATION_INTENT_MAX_LENGTH ||
    !CAPABILITY_IDS.has(capabilityId as AgentCapabilityId) ||
    (clientMessageId !== undefined && (!clientMessageId || clientMessageId.length > 128)) ||
    input.requiresConfirmation !== true
  ) {
    return null;
  }
  return {
    originalIntent,
    capabilityId: capabilityId as AgentCapabilityId,
    ...(clientMessageId ? { clientMessageId } : {}),
    requiresConfirmation: true,
  };
}

export interface AuthoritativeLifecycleEvent {
  kind: ProactiveLifecycleEventKind;
  idempotencyKey: string;
  userId: string;
  organizationId: string;
  resourceId: string;
  origin: LifecycleEventOrigin;
  preferredChannel?: ProactiveGreetingPlatform;
  connectorName?: string;
  /** Authenticated target agent; required whenever continuation is present. */
  agentId?: string;
  continuation?: LifecycleCapabilityContinuation;
}

export interface LifecycleFollowUpResult {
  queued: boolean;
  channel?: ProactiveGreetingPlatform;
  sessionId?: string;
  reason?: "no_verified_delivery_channel";
}

interface VerifiedLifecycleRoute {
  platform: ProactiveGreetingPlatform;
  platformUserId: string;
}

interface LifecycleFollowUpDependencies {
  findUser: (userId: string) => Promise<User | undefined>;
  enqueue: typeof enqueueProactiveLifecycleMessage;
  now: () => Date;
}

const LIFECYCLE_NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const defaultDependencies: LifecycleFollowUpDependencies = {
  findUser: (userId) => usersRepository.findById(userId),
  enqueue: enqueueProactiveLifecycleMessage,
  now: () => new Date(),
};

export class LifecycleFollowUpAuthorizationError extends Error {
  constructor() {
    super("Lifecycle follow-up identity does not match the authoritative user");
    this.name = "LifecycleFollowUpAuthorizationError";
  }
}

function routeForPlatform(
  user: User,
  platform: ProactiveGreetingPlatform,
): VerifiedLifecycleRoute | null {
  if (platform === "discord" && user.discord_id) {
    return { platform, platformUserId: user.discord_id };
  }
  if (platform === "telegram" && user.telegram_id) {
    return { platform, platformUserId: user.telegram_id };
  }
  if (
    (platform === "blooio" || platform === "twilio") &&
    user.phone_number &&
    user.phone_verified === true
  ) {
    return { platform, platformUserId: user.phone_number };
  }
  return null;
}

/** Prefer an explicit verified channel, then the originating channel, then a deterministic fallback. */
export function resolveLifecycleFollowUpRoute(
  user: User,
  event: AuthoritativeLifecycleEvent,
): VerifiedLifecycleRoute | null {
  if (event.preferredChannel) {
    const preferred = routeForPlatform(user, event.preferredChannel);
    if (preferred) return preferred;
  }
  if (event.origin !== "web" && event.origin !== "app") {
    const origin = routeForPlatform(user, event.origin);
    if (origin) return origin;
  }
  // A linked identity proves destination ownership, not consent to receive an
  // unsolicited message triggered from another surface. Keep web/app events
  // pending for an authenticated in-app/next-chat consumer instead.
  return { platform: "in_app", platformUserId: user.id };
}

function cleanConnectorName(value: string | undefined): string {
  const cleaned = value
    ?.replaceAll(/[\r\n\t]/g, " ")
    .replaceAll(/\s+/g, " ")
    .trim();
  return cleaned && cleaned.length <= 60 ? cleaned : "That connector";
}

/** Safe server-authored wording; user intent is never interpolated as instructions. */
export function composeLifecycleFollowUp(events: AuthoritativeLifecycleEvent[]): string {
  const kinds = new Set(events.map((event) => event.kind));
  if (kinds.has("workspace_ready") && kinds.has("subscription_upgraded")) {
    return "Your upgrade is complete and your personal workspace is ready. I can continue when you're back.";
  }
  if (kinds.has("workspace_ready")) {
    return "Your personal workspace is ready. I can continue when you're back.";
  }
  if (kinds.has("subscription_upgraded")) {
    return "Your upgrade is complete. I can continue when you're back.";
  }
  const connector = events.find((event) => event.kind === "connector_connected");
  return `${cleanConnectorName(connector?.connectorName)} is connected. I can continue your pending request when you're back.`;
}

async function lifecycleDigest(events: AuthoritativeLifecycleEvent[]): Promise<string> {
  const canonical = [...events]
    .map((event) =>
      JSON.stringify([
        event.userId,
        event.organizationId,
        event.origin,
        event.kind,
        event.idempotencyKey,
        event.resourceId,
        event.agentId ?? null,
        event.continuation
          ? [
              event.continuation.originalIntent,
              event.continuation.capabilityId,
              event.continuation.clientMessageId ?? null,
              event.continuation.requiresConfirmation,
            ]
          : null,
      ]),
    )
    .sort()
    .join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertEventGroup(events: AuthoritativeLifecycleEvent[]): void {
  if (events.length === 0 || events.length > 3) {
    throw new Error("Lifecycle follow-up requires one to three events");
  }
  const [first] = events;
  if (!first) throw new Error("Lifecycle follow-up requires an event");
  for (const event of events) {
    if (
      event.userId !== first.userId ||
      event.organizationId !== first.organizationId ||
      event.origin !== first.origin ||
      event.idempotencyKey.length < 8 ||
      event.idempotencyKey.length > 180 ||
      !event.resourceId ||
      event.resourceId.length > 180 ||
      (event.agentId !== undefined && (event.agentId.length < 1 || event.agentId.length > 180)) ||
      (event.continuation !== undefined &&
        (!event.agentId || parseLifecycleCapabilityContinuation(event.continuation) === null))
    ) {
      throw new Error("Invalid lifecycle follow-up event group");
    }
  }
}

/**
 * Coalesces related lifecycle events into one durable notice. Replaying the
 * same authoritative events produces the same queue key and provider nonce.
 */
export async function enqueueUserLifecycleFollowUps(
  events: AuthoritativeLifecycleEvent[],
  dependencies: Partial<LifecycleFollowUpDependencies> = {},
): Promise<LifecycleFollowUpResult> {
  assertEventGroup(events);
  const deps = { ...defaultDependencies, ...dependencies };
  const first = events[0]!;
  const user = await deps.findUser(first.userId);
  if (!user || user.id !== first.userId || user.organization_id !== first.organizationId) {
    throw new LifecycleFollowUpAuthorizationError();
  }
  const route = resolveLifecycleFollowUpRoute(user, first);
  if (!route) return { queued: false, reason: "no_verified_delivery_channel" };

  const digest = await lifecycleDigest(events);
  const sessionId = `lifecycle:${digest.slice(0, 48)}`;
  const createdAt = deps.now();
  const lifecycleEvents: ProactiveLifecycleEventMetadata[] = events.map((event) => ({
    kind: event.kind,
    idempotencyKey: event.idempotencyKey,
    userId: event.userId,
    organizationId: event.organizationId,
    resourceId: event.resourceId,
    origin: event.origin,
    preferredChannel: route.platform,
    ...(event.agentId ? { agentId: event.agentId } : {}),
    ...(event.continuation ? { continuation: event.continuation } : {}),
  }));
  await deps.enqueue(route.platform, {
    sessionId,
    platformUserId: route.platformUserId,
    message: composeLifecycleFollowUp(events),
    createdAt: createdAt.toISOString(),
    expiresAt: new Date(createdAt.getTime() + LIFECYCLE_NOTICE_TTL_MS).toISOString(),
    deliveryNonce: digest.slice(0, 25),
    lifecycleEvents,
  });
  return { queued: true, channel: route.platform, sessionId };
}
