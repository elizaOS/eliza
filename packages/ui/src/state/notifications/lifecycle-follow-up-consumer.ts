/**
 * Accepts leased cloud lifecycle notices into durable browser storage before
 * acknowledging them, then projects them into the existing in-app inbox.
 */

import type { AgentNotification } from "@elizaos/core";
import { logger } from "@elizaos/logger";
import { type CloudLifecycleFollowUpNotice, client } from "../../api/client";
import { loadPersistedActiveServer } from "../persistence";

const STORAGE_KEY_PREFIX = "elizaos:accepted-lifecycle-follow-ups:v2:";
const MAX_ACCEPTED_NOTICES = 50;
const consumeInFlight = new Map<string, Promise<void>>();
const LIFECYCLE_EVENT_KINDS = new Set([
  "workspace_ready",
  "subscription_upgraded",
  "connector_connected",
]);
const CAPABILITY_IDS = new Set([
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

interface AcceptedNotice {
  notice: CloudLifecycleFollowUpNotice;
  acceptedAt: number;
}

function isLifecycleNotice(
  value: unknown,
): value is CloudLifecycleFollowUpNotice {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    /^lifecycle:[a-f0-9]{48}$/.test(record.sessionId) &&
    typeof record.leaseId === "string" &&
    /^[A-Za-z0-9_-]{1,25}$/.test(record.leaseId) &&
    typeof record.message === "string" &&
    record.message.length > 0 &&
    record.message.length <= 2000 &&
    typeof record.createdAt === "string" &&
    Number.isFinite(Date.parse(record.createdAt)) &&
    typeof record.expiresAt === "string" &&
    Number.isFinite(Date.parse(record.expiresAt)) &&
    Array.isArray(record.lifecycleEvents) &&
    record.lifecycleEvents.length > 0 &&
    record.lifecycleEvents.length <= 10 &&
    record.lifecycleEvents.every((event) => {
      if (!event || typeof event !== "object") return false;
      const candidate = event as Record<string, unknown>;
      const continuation = candidate.continuation;
      const validContinuation =
        continuation === undefined ||
        (continuation !== null &&
          typeof continuation === "object" &&
          !Array.isArray(continuation) &&
          typeof (continuation as Record<string, unknown>).originalIntent ===
            "string" &&
          ((continuation as Record<string, unknown>).originalIntent as string)
            .length > 0 &&
          ((continuation as Record<string, unknown>).originalIntent as string)
            .length <= 4000 &&
          typeof (continuation as Record<string, unknown>).capabilityId ===
            "string" &&
          CAPABILITY_IDS.has(
            (continuation as Record<string, unknown>).capabilityId as string,
          ) &&
          (continuation as Record<string, unknown>).requiresConfirmation ===
            true &&
          ((continuation as Record<string, unknown>).clientMessageId ===
            undefined ||
            (typeof (continuation as Record<string, unknown>)
              .clientMessageId === "string" &&
              (
                (continuation as Record<string, unknown>)
                  .clientMessageId as string
              ).length > 0 &&
              (
                (continuation as Record<string, unknown>)
                  .clientMessageId as string
              ).length <= 128)));
      const validAgentId =
        candidate.agentId === undefined ||
        (typeof candidate.agentId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            candidate.agentId,
          ));
      return (
        typeof candidate.kind === "string" &&
        LIFECYCLE_EVENT_KINDS.has(candidate.kind) &&
        typeof candidate.idempotencyKey === "string" &&
        candidate.idempotencyKey.length > 0 &&
        candidate.idempotencyKey.length <= 512 &&
        typeof candidate.resourceId === "string" &&
        candidate.resourceId.length > 0 &&
        candidate.resourceId.length <= 256 &&
        validContinuation &&
        validAgentId &&
        (continuation === undefined || candidate.agentId !== undefined)
      );
    })
  );
}

function storageKey(authorityKey: string): string {
  return `${STORAGE_KEY_PREFIX}${encodeURIComponent(authorityKey)}`;
}

function readAccepted(
  authorityKey: string,
  now = Date.now(),
): AcceptedNotice[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(storageKey(authorityKey)) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is AcceptedNotice => {
        if (!entry || typeof entry !== "object") return false;
        const candidate = entry as Partial<AcceptedNotice>;
        const expiresAt = candidate.notice
          ? Date.parse(candidate.notice.expiresAt)
          : Number.NaN;
        return (
          typeof candidate.acceptedAt === "number" &&
          isLifecycleNotice(candidate.notice) &&
          Number.isFinite(expiresAt) &&
          expiresAt > now
        );
      })
      .slice(0, MAX_ACCEPTED_NOTICES);
  } catch {
    // error-policy:J3 malformed local acceptance state is ignored and replaced
    // only after a new server lease is successfully validated.
    return [];
  }
}

function writeAccepted(
  authorityKey: string,
  entries: AcceptedNotice[],
): boolean {
  if (typeof window === "undefined") return false;
  try {
    const serialized = JSON.stringify(entries.slice(0, MAX_ACCEPTED_NOTICES));
    const key = storageKey(authorityKey);
    window.localStorage.setItem(key, serialized);
    return window.localStorage.getItem(key) === serialized;
  } catch {
    // error-policy:J4 without durable client acceptance the server lease stays
    // unacknowledged and will be offered again after expiry.
    return false;
  }
}

function notificationId(sessionId: string): string {
  const hex = sessionId.slice("lifecycle:".length, "lifecycle:".length + 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Permanently remove accepted lifecycle notices from one authenticated authority. */
export function dismissAcceptedCloudLifecycleFollowUps(
  authorityKey: string,
  notificationIds: readonly string[],
): boolean {
  if (notificationIds.length === 0) return true;
  const ids = new Set(notificationIds);
  const accepted = readAccepted(authorityKey);
  const retained = accepted.filter(
    (entry) => !ids.has(notificationId(entry.notice.sessionId)),
  );
  return (
    retained.length === accepted.length || writeAccepted(authorityKey, retained)
  );
}

function notificationTitle(notice: CloudLifecycleFollowUpNotice): string {
  const kinds = new Set(notice.lifecycleEvents.map((event) => event.kind));
  if (kinds.has("connector_connected")) return "Connection ready";
  if (kinds.has("subscription_upgraded")) return "Upgrade complete";
  return "Workspace ready";
}

function toNotification(
  notice: CloudLifecycleFollowUpNotice,
): AgentNotification {
  const activeAgentId = loadPersistedActiveServer()?.cloudRuntimeAgentId;
  const resumableIntent = notice.lifecycleEvents.find(
    (event) =>
      event.continuation &&
      event.agentId !== undefined &&
      event.agentId === activeAgentId,
  )?.continuation?.originalIntent;
  return {
    id: notificationId(notice.sessionId),
    title: notificationTitle(notice),
    body: notice.message,
    category: "general",
    priority: "normal",
    source: "agent",
    deepLink: resumableIntent
      ? `/chat?prefill=${encodeURIComponent(resumableIntent)}`
      : "/chat",
    groupKey: notice.sessionId,
    createdAt: Date.parse(notice.createdAt),
    readAt: null,
    data: {
      lifecycleEvents: notice.lifecycleEvents,
      continuations: notice.lifecycleEvents.flatMap((event) =>
        event.continuation && event.agentId
          ? [{ ...event.continuation, agentId: event.agentId }]
          : [],
      ),
      continuationPolicy: "offer_only_never_auto_execute",
    },
  };
}

export async function consumeCloudLifecycleFollowUps(
  authorityKey: string,
  accept: (notification: AgentNotification) => void,
): Promise<void> {
  const existing = consumeInFlight.get(authorityKey);
  if (existing) return existing;
  const run = async () => {
    const accepted = readAccepted(authorityKey);
    for (const entry of accepted) accept(toNotification(entry.notice));

    const response = await client.claimCloudLifecycleFollowUps();
    const claimed = response.notices.filter(isLifecycleNotice);
    if (claimed.length === 0) return;
    const bySession = new Map(
      accepted.map((entry) => [entry.notice.sessionId, entry] as const),
    );
    const newlyAccepted: CloudLifecycleFollowUpNotice[] = [];
    for (const notice of claimed) {
      if (!bySession.has(notice.sessionId)) {
        bySession.set(notice.sessionId, { notice, acceptedAt: Date.now() });
        newlyAccepted.push(notice);
      }
    }
    const durable = [...bySession.values()]
      .sort((left, right) => right.acceptedAt - left.acceptedAt)
      .slice(0, MAX_ACCEPTED_NOTICES);
    if (!writeAccepted(authorityKey, durable)) return;
    for (const notice of newlyAccepted) accept(toNotification(notice));

    await client.acknowledgeCloudLifecycleFollowUps(
      claimed.map(({ sessionId, leaseId }) => ({ sessionId, leaseId })),
    );
  };
  const tracked = run()
    .catch((error) => {
      // error-policy:J4 the notice remains server-leased/unacknowledged and is
      // retried later; the existing inbox remains usable.
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "[lifecycle-follow-up] consume failed",
      );
    })
    .finally(() => {
      consumeInFlight.delete(authorityKey);
    });
  consumeInFlight.set(authorityKey, tracked);
  return tracked;
}

export function __resetLifecycleFollowUpConsumerForTests(): void {
  consumeInFlight.clear();
}
