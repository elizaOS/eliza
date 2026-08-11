/**
 * Delivers proactive post-sign-in onboarding greetings claimed from the cloud
 * API. The API's drain endpoint removes entries atomically before returning
 * them (at-most-once), so delivery here never retries a failed DM send:
 * re-queueing on the gateway side would reintroduce the double-send class the
 * atomic claim exists to prevent. Callers supply fetch/send/auth closures the
 * same way managed-message-egress does.
 */

export interface PendingGreeting {
  sessionId?: string;
  platformUserId?: string;
  message?: string;
}

export interface GreetingDeliveryReport {
  claimed: number;
  delivered: number;
  malformed: number;
  failed: number;
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

/** Discord hard cap on message content length. */
const MAX_DM_LENGTH = 2000;

/**
 * Claims pending greetings via `drain` and sends each with `sendDirectMessage`.
 *
 * - 401 from the drain: `refreshAuth` runs and the batch is skipped; the
 *   entries were never claimed, so the next poll delivers them.
 * - Non-OK drain status: reported, nothing claimed, nothing lost.
 * - Send failure: logged via the report; the entry is already claimed, so a
 *   user with closed DMs (Discord 50007) or a deleted account is terminal.
 */
export async function drainAndDeliverGreetings(options: {
  drain: () => Promise<Response>;
  sendDirectMessage: (userId: string, content: string) => Promise<void>;
  refreshAuth?: () => Promise<void>;
  onEvent?: (event: {
    kind: "drain-failed" | "malformed" | "delivered" | "send-failed";
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

  for (const greeting of greetings) {
    const userId = greeting.platformUserId;
    const content = greeting.message?.trim().slice(0, MAX_DM_LENGTH);
    if (!userId || !content) {
      report.malformed += 1;
      options.onEvent?.({
        kind: "malformed",
        sessionId: greeting.sessionId ?? null,
      });
      continue;
    }
    try {
      await options.sendDirectMessage(userId, content);
      report.delivered += 1;
      options.onEvent?.({
        kind: "delivered",
        sessionId: greeting.sessionId ?? null,
      });
    } catch (error) {
      report.failed += 1;
      options.onEvent?.({
        kind: "send-failed",
        sessionId: greeting.sessionId ?? null,
        error,
      });
    }
  }

  return report;
}
