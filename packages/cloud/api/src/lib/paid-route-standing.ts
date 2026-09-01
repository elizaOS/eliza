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

type CompatibilityStandingReason =
  | "account_inactive"
  | "membership_missing"
  | "moderation_blocked"
  | "organization_inactive";

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

function standingMessage(reason: CompatibilityStandingReason): string {
  switch (reason) {
    case "moderation_blocked":
      return "Account access is blocked by policy moderation";
    case "organization_inactive":
      return "Organization is inactive";
    case "membership_missing":
      return "Account is not associated with an active organization";
    case "account_inactive":
      return "Account is inactive";
  }
}

async function compatibilityStandingReason(
  caller: GenerativeRouteCaller,
  compatibility: "hono" | "raw" | undefined,
): Promise<CompatibilityStandingReason | null> {
  if (caller.authSource !== "compatibility") return null;

  // Raw wallet/mobile auth proves possession and organization presence but
  // does not uniformly prove current user and organization lifecycle. Resolve
  // that primary authority once here; this path never addresses Redis again.
  if (compatibility === "raw") {
    const { usersRepository } = await import("@/db/repositories/users");
    const { organizationLifecycleAllowsNewWork } = await import(
      "@/lib/services/account-lifecycle-authority"
    );
    const current = await usersRepository.findWithOrganizationForWrite(
      caller.user.id,
    );
    if (!current?.is_active) return "account_inactive";
    if (
      current.organization_id !== caller.user.organization_id ||
      !current.organization
    ) {
      return "membership_missing";
    }
    const lifecycleState = current.organization.account_lifecycle_state;
    if (
      (lifecycleState !== "active" &&
        lifecycleState !== "deletion_recovery" &&
        lifecycleState !== "deletion_irreversible") ||
      !organizationLifecycleAllowsNewWork({
        state: lifecycleState,
        revision: current.organization.account_lifecycle_revision,
        active: current.organization.is_active,
        deletionRequestId: current.organization.account_deletion_request_id,
      })
    ) {
      return "organization_inactive";
    }
  }

  const { adminService } = await import("@/lib/services/admin");
  return (await adminService.shouldBlockUser(caller.user.id))
    ? "moderation_blocked"
    : null;
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
  let denialLogged = false;
  try {
    const caller = await requireGenerativeRouteCaller(c, {
      compatibility: options.compatibility,
      awaitWarmingMs:
        options.coldDeadlineMs ?? DEFAULT_COLD_STANDING_DEADLINE_MS,
    });

    const compatibilityReason = await compatibilityStandingReason(
      caller,
      options.compatibility,
    );
    if (compatibilityReason) {
      denialLogged = true;
      logger.warn("[PaidRouteStanding] blocked external work", {
        route: options.route,
        traceId,
        authSource: caller.authSource,
        decision: "denied",
        status: 403,
        reason: compatibilityReason,
        providerDispatched: false,
      });
      throw new ApiError(
        403,
        "access_denied",
        standingMessage(compatibilityReason),
        { reason: compatibilityReason },
      );
    }

    return caller;
  } catch (error) {
    // error-policy:J2 attach the secret-free route decision to diagnostics,
    // then preserve the original typed boundary error and its safe response.
    // The combined resolver already logs its cache/authoritative phase. This
    // route-bound record provides the missing external-side-effect decision
    // without including credentials, provider payloads, or raw cache values.
    if (!denialLogged) {
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
