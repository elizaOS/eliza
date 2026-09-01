/**
 * Admits authenticated non-generative paid routes through the shared combined
 * standing decision before any debit, provider lease, or external dispatch.
 * Cold requests consume the resolver's one-shot authoritative continuation;
 * they never perform a second cache read. Durable workflows retain ownership
 * of their synchronous receipt, debit, refund, and reconciliation semantics.
 */

import {
  type GenerativeRouteCaller,
  requireGenerativeRouteCaller,
} from "@/api-app/lib/generative-route-auth";
import { ApiError } from "@/lib/api/cloud-worker-errors";
import { logger } from "@/lib/utils/logger";
import type { AppContext } from "@/types/cloud-worker-env";

const DEFAULT_COLD_STANDING_DEADLINE_MS = 2_500;

export interface PaidRouteStandingOptions {
  /** Stable, secret-free route label used in denial diagnostics. */
  route: string;
  compatibility?: "hono" | "raw";
  coldDeadlineMs?: number;
}

function errorReason(error: unknown): unknown {
  if (!error || typeof error !== "object" || !("details" in error)) {
    return undefined;
  }
  const details = (error as { details?: unknown }).details;
  if (!details || typeof details !== "object" || !("reason" in details)) {
    return undefined;
  }
  return (details as { reason?: unknown }).reason;
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return undefined;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Resolve one paid-route caller from the combined standing cache. A cold
 * continuation is awaited once and consumed directly, so a miss still has one
 * cache read and no readback after the authoritative deferred write.
 */
export async function requirePaidRouteStanding(
  c: AppContext,
  options: PaidRouteStandingOptions,
): Promise<GenerativeRouteCaller> {
  const traceId = c.get("traceId") ?? c.get("requestId") ?? "unavailable";
  try {
    const caller = await requireGenerativeRouteCaller(c, {
      compatibility: options.compatibility,
      awaitWarmingMs:
        options.coldDeadlineMs ?? DEFAULT_COLD_STANDING_DEADLINE_MS,
    });

    // Wallet proofs and non-Worker compatibility callers cannot reuse the
    // combined cache. Their auth path already proves current user, org, key,
    // and lifecycle state; moderation is the remaining standing authority.
    const blockedByModeration =
      caller.authSource === "compatibility" &&
      (await import("@/lib/services/admin").then(({ adminService }) =>
        adminService.shouldBlockUser(caller.user.id),
      ));
    if (blockedByModeration) {
      logger.warn("[PaidRouteStanding] blocked external work", {
        route: options.route,
        traceId,
        authSource: caller.authSource,
        decision: "denied",
        status: 403,
        reason: "moderation_blocked",
        providerDispatched: false,
      });
      throw new ApiError(
        403,
        "access_denied",
        "Account access is blocked by policy moderation",
        { reason: "moderation_blocked" },
      );
    }

    return caller;
  } catch (error) {
    // error-policy:J2 attach the secret-free route decision to diagnostics,
    // then preserve the original typed boundary error and its safe response.
    // The combined resolver already logs its cache/authoritative phase. This
    // route-bound record provides the missing external-side-effect decision
    // without including credentials, provider payloads, or raw cache values.
    if (errorReason(error) !== "moderation_blocked") {
      logger.warn("[PaidRouteStanding] blocked external work", {
        route: options.route,
        traceId,
        decision: "denied",
        status: errorStatus(error) ?? "unavailable",
        reason: errorReason(error) ?? "authorization_failed",
        providerDispatched: false,
      });
    }
    throw error;
  }
}
