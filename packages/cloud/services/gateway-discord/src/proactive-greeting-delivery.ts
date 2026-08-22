/**
 * Delivers proactive post-sign-in onboarding greetings claimed from the cloud
 * API. The API leases rather than deletes each entry; successful and
 * definitively terminal sends are acknowledged, while retryable/ambiguous
 * failures become claimable after lease expiry. The gateway supplies the
 * entry's stable nonce with `enforceNonce`, making provider retries idempotent.
 */

import { chunkDiscordText, discordChunkNonce } from "./discord-text-chunks";

export interface PendingGreeting {
  sessionId?: string;
  platformUserId?: string;
  message?: string;
  leaseId?: string;
  deliveryNonce?: string;
}

export interface GreetingDeliveryReport {
  claimed: number;
  delivered: number;
  malformed: number;
  failed: number;
  acknowledged: number;
  retainedForRetry: number;
  /** True when the drain response required an auth refresh (401). */
  authRefreshed: boolean;
}

function parsePendingGreetings(body: unknown): PendingGreeting[] {
  if (!body || typeof body !== "object") return [];
  const greetings = (body as { greetings?: unknown }).greetings;
  if (!Array.isArray(greetings)) return [];
  return greetings.filter(
    (entry): entry is PendingGreeting =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

/**
 * True only when Discord definitively rejected a DM in a way retrying this
 * short-lived greeting cannot repair. Rate limits, 5xx responses, and network
 * failures remain recoverable through the queue lease and enforced nonce.
 */
export function isTerminalDiscordDirectMessageError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const raw =
    record.rawError && typeof record.rawError === "object"
      ? (record.rawError as Record<string, unknown>)
      : undefined;
  const code = typeof record.code === "number" ? record.code : raw?.code;
  if (code === 50007 || code === 10013) return true;
  const status =
    typeof record.status === "number"
      ? record.status
      : typeof record.statusCode === "number"
        ? record.statusCode
        : undefined;
  return status === 400 || status === 403 || status === 404;
}

/** True when Discord returned an explicit client rejection before acceptance. */
export function isKnownDiscordDirectMessageRejection(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  const raw =
    record.rawError && typeof record.rawError === "object"
      ? (record.rawError as Record<string, unknown>)
      : undefined;
  const code = typeof record.code === "number" ? record.code : raw?.code;
  const status =
    typeof record.status === "number"
      ? record.status
      : typeof record.statusCode === "number"
        ? record.statusCode
        : undefined;
  if (typeof status === "number") return status >= 400 && status < 500;
  return code === 50007 || code === 10013;
}

/**
 * Leases pending greetings and sends each with a stable provider nonce.
 *
 * - 401 from the drain: `refreshAuth` runs and the batch is skipped; the
 *   entries were never claimed, so the next poll delivers them.
 * - Non-OK drain status: reported, nothing claimed, nothing lost.
 * - Delivered and definitively terminal entries are acknowledged.
 * - Retryable or ambiguous failures retain their entry for lease recovery.
 */
export async function drainAndDeliverGreetings(options: {
  drain: () => Promise<Response>;
  acknowledge: (
    acknowledgements: Array<{ sessionId: string; leaseId: string }>,
  ) => Promise<Response>;
  sendDirectMessage: (
    userId: string,
    content: string,
    deliveryNonce: string,
  ) => Promise<void>;
  isTerminalError?: (error: unknown) => boolean;
  refreshAuth?: () => Promise<void>;
  onEvent?: (event: {
    kind:
      | "drain-failed"
      | "ack-failed"
      | "malformed"
      | "delivered"
      | "send-failed";
    sessionId?: string | null;
    status?: number;
    error?: unknown;
  }) => void;
}): Promise<GreetingDeliveryReport> {
  const report: GreetingDeliveryReport = {
    claimed: 0,
    delivered: 0,
    malformed: 0,
    failed: 0,
    acknowledged: 0,
    retainedForRetry: 0,
    authRefreshed: false,
  };

  const response = await options.drain();
  if (response.status === 401) {
    report.authRefreshed = true;
    await options.refreshAuth?.();
    return report;
  }
  if (!response.ok) {
    options.onEvent?.({ kind: "drain-failed", status: response.status });
    return report;
  }

  const greetings = parsePendingGreetings(await response.json());
  report.claimed = greetings.length;
  const acknowledgements: Array<{ sessionId: string; leaseId: string }> = [];

  for (const greeting of greetings) {
    const userId = greeting.platformUserId;
    const content = greeting.message?.trim();
    const sessionId = greeting.sessionId;
    const leaseId = greeting.leaseId;
    const deliveryNonce = greeting.deliveryNonce;
    if (!userId || !content || !sessionId || !leaseId || !deliveryNonce) {
      report.malformed += 1;
      options.onEvent?.({
        kind: "malformed",
        sessionId: greeting.sessionId ?? null,
      });
      if (sessionId && leaseId) acknowledgements.push({ sessionId, leaseId });
      continue;
    }
    try {
      const chunks = chunkDiscordText(content);
      for (let index = 0; index < chunks.length; index += 1) {
        await options.sendDirectMessage(
          userId,
          chunks[index] ?? "",
          chunks.length === 1
            ? deliveryNonce
            : discordChunkNonce(deliveryNonce, index),
        );
      }
      report.delivered += 1;
      acknowledgements.push({ sessionId, leaseId });
      options.onEvent?.({
        kind: "delivered",
        sessionId: greeting.sessionId ?? null,
      });
    } catch (error) {
      // error-policy:J4 A DM failure degrades this courtesy notification only;
      // retryable work remains durable and terminal work is explicitly acked.
      report.failed += 1;
      if (options.isTerminalError?.(error) === true) {
        acknowledgements.push({ sessionId, leaseId });
      } else {
        report.retainedForRetry += 1;
      }
      options.onEvent?.({
        kind: "send-failed",
        sessionId: greeting.sessionId ?? null,
        error,
      });
    }
  }

  if (acknowledgements.length > 0) {
    let ackResponse = await options.acknowledge(acknowledgements);
    if (ackResponse.status === 401 && options.refreshAuth) {
      await options.refreshAuth();
      ackResponse = await options.acknowledge(acknowledgements);
    }
    if (!ackResponse.ok) {
      options.onEvent?.({ kind: "ack-failed", status: ackResponse.status });
    } else {
      const body = (await ackResponse.json()) as { acknowledged?: unknown };
      report.acknowledged =
        typeof body.acknowledged === "number" ? body.acknowledged : 0;
    }
  }

  return report;
}
