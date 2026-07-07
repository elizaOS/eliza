/**
 * Agent-reply → Web Push bridge.
 *
 * When an agent produces a reply and the target user has NO live foreground
 * client for that (user, agent), enqueue a web-push so a closed/installed PWA
 * surfaces the reply. On send, subscriptions that return 404/410 are pruned
 * from the store.
 *
 * Foreground liveness is injected (`isForegroundActive`) so this module has no
 * dependency on the presence/WS layer — the caller decides how "live" is
 * determined (client heartbeat, WS attach, last-seen). When it can't be
 * determined, the safe default is to notify (a dedicated agent has no WS to
 * fall back on, so a missed push is worse than a redundant one).
 */

import type { webPushSubscriptionsRepository } from "../../db/repositories/web-push-subscriptions";
import { logger as sharedLogger } from "../utils/logger";
import { getWebPushVapidConfig, type WebPushEnv } from "./config";
import { sendWebPushBatch, type WebPushNotificationPayload } from "./sender";

/** Minimal logger seam so unit tests can inject a fake and avoid the DB/core
 *  graph the shared cloud logger pulls in. Production uses the shared
 *  structured logger (redaction + sink policy). */
export interface NotifyLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
}

export interface AgentReplyPushInput {
  userId: string;
  agentId: string;
  /** Reply text — trimmed/truncated into the notification body. */
  replyText: string;
  /** Notification title (usually the agent/character name). */
  title: string;
  conversationId?: string;
  /** Deep link the notificationclick should route to (root-relative). */
  deepLink?: string;
  /** Unread count to set as the app badge on receipt. */
  badgeCount?: number;
}

export interface NotifyDeps {
  env?: WebPushEnv;
  /**
   * Returns true when a foreground client is actively connected for this
   * (user, agent) — in which case we DON'T push. Absent ⇒ treat as not-live
   * (push), since the caller couldn't prove a live client.
   */
  isForegroundActive?: (userId: string, agentId: string) => Promise<boolean> | boolean;
  /** Injectable repository (for tests). */
  repository?: typeof webPushSubscriptionsRepository;
  /** Injectable batch sender (for tests). */
  sendBatch?: typeof sendWebPushBatch;
  /** Injectable logger (for tests); defaults to the shared cloud logger. */
  logger?: NotifyLogger;
}

/** Notification body max length before we ellipsize. */
const MAX_BODY_LENGTH = 180;

function toBody(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_BODY_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_BODY_LENGTH - 1).trimEnd()}…`;
}

export type NotifyResult =
  | {
      pushed: false;
      reason: "unconfigured" | "foreground-active" | "no-subscriptions" | "failed";
    }
  | { pushed: true; sent: number; failed: number; pruned: number };

/**
 * Enqueue a web-push for an agent reply when no foreground client is live.
 * Returns a structured result; never throws (a push failure must not break the
 * reply path).
 */
export async function notifyAgentReply(
  input: AgentReplyPushInput,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const logger: NotifyLogger = deps.logger ?? sharedLogger;
  try {
    const vapid = getWebPushVapidConfig(deps.env);
    if (!vapid) return { pushed: false, reason: "unconfigured" };

    // If a foreground client is live, don't disturb with a push.
    if (deps.isForegroundActive) {
      const live = await deps.isForegroundActive(input.userId, input.agentId);
      if (live) return { pushed: false, reason: "foreground-active" };
    }

    // Lazy-load the default repository so this module's graph stays free of the
    // Drizzle/DB layer for unit tests that inject a fake repository.
    const repo =
      deps.repository ??
      (await import("../../db/repositories/web-push-subscriptions")).webPushSubscriptionsRepository;
    const rows = await repo.listForUserAgent(input.userId, input.agentId);
    if (rows.length === 0) return { pushed: false, reason: "no-subscriptions" };

    const payload: WebPushNotificationPayload = {
      title: input.title,
      body: toBody(input.replyText),
      tag: input.conversationId ?? input.agentId,
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      agentId: input.agentId,
      ...(input.deepLink ? { deepLink: input.deepLink } : {}),
      ...(typeof input.badgeCount === "number" ? { badgeCount: input.badgeCount } : {}),
    };

    const sendBatch = deps.sendBatch ?? sendWebPushBatch;
    const result = await sendBatch(
      rows.map((row) => ({
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      })),
      payload,
      vapid,
    );

    let pruned = 0;
    if (result.goneEndpoints.length > 0) {
      pruned = await repo.pruneEndpoints(result.goneEndpoints);
      logger.info("[web-push] pruned dead subscriptions", {
        userId: input.userId,
        agentId: input.agentId,
        pruned,
      });
    }

    return {
      pushed: true,
      sent: result.sent,
      failed: result.failed,
      pruned,
    };
  } catch (error) {
    // error-policy:J4 push delivery is an optional side effect of a completed reply; return an explicit failure so callers never read infrastructure errors as an empty subscription set.
    logger.warn("[web-push] notifyAgentReply failed (non-fatal)", {
      userId: input.userId,
      agentId: input.agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { pushed: false, reason: "failed" };
  }
}
