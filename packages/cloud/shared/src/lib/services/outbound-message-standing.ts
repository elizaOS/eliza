/**
 * Resolves the account-standing decision for customer-funded outbound messages.
 * A warm dispatch consumes one cache read; a miss hydrates the complete actor,
 * membership, organization lifecycle, and moderation decision in one SQL query
 * and projects it asynchronously without reading the cache back.
 */

import { eq } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { userModerationStatus } from "../../db/schemas/moderation-violations";
import { organizations } from "../../db/schemas/organizations";
import { users } from "../../db/schemas/users";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";
import { organizationLifecycleAllowsNewWork } from "./account-lifecycle-authority";

const VERSION = 1 as const;

export type OutboundMessageStandingReason =
  | "account_missing"
  | "account_inactive"
  | "membership_missing"
  | "organization_inactive"
  | "moderation_blocked";

export type OutboundMessageStandingDecision =
  | { allowed: true; source: "cache" | "authoritative" }
  | {
      allowed: false;
      source: "cache" | "authoritative";
      reason: OutboundMessageStandingReason;
    };

interface CachedStanding {
  v: typeof VERSION;
  organizationId: string;
  userId: string;
  cachedAt: number;
  decision: "allowed" | "denied";
  reason?: OutboundMessageStandingReason;
}

export interface OutboundMessageStandingOptions {
  defer?: (promise: Promise<unknown>) => void;
}

const reasons = new Set<OutboundMessageStandingReason>([
  "account_missing",
  "account_inactive",
  "membership_missing",
  "organization_inactive",
  "moderation_blocked",
]);

function isCachedStanding(
  value: unknown,
  organizationId: string,
  userId: string,
): value is CachedStanding {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return (
    entry.v === VERSION &&
    entry.organizationId === organizationId &&
    entry.userId === userId &&
    typeof entry.cachedAt === "number" &&
    Number.isFinite(entry.cachedAt) &&
    (entry.decision === "allowed" ||
      (entry.decision === "denied" &&
        typeof entry.reason === "string" &&
        reasons.has(entry.reason as OutboundMessageStandingReason)))
  );
}

function decisionFromEntry(
  entry: CachedStanding,
  source: "cache" | "authoritative",
): OutboundMessageStandingDecision {
  return entry.decision === "allowed"
    ? { allowed: true, source }
    : { allowed: false, source, reason: entry.reason as OutboundMessageStandingReason };
}

function projectStanding(entry: CachedStanding, options: OutboundMessageStandingOptions): void {
  const projection = cache
    .setWithOutcome(
      CacheKeys.outboundMessageStanding.actor(entry.organizationId, entry.userId),
      entry,
      CacheTTL.outboundMessageStanding,
      { keyClass: "inference_auth" },
    )
    .then(() => undefined)
    .catch((error) => {
      // error-policy:J7 the authoritative decision already governs this send;
      // projection failure is diagnostic and must not fabricate authorization.
      logger.warn("[OutboundMessageStanding] asynchronous projection failed", {
        organizationId: entry.organizationId,
        userId: entry.userId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  if (options.defer) options.defer(projection);
  else void projection;
}

/** Resolve standing with exactly one cache read and no post-write readback. */
export async function resolveOutboundMessageStanding(
  organizationId: string,
  userId: string,
  options: OutboundMessageStandingOptions = {},
): Promise<OutboundMessageStandingDecision> {
  const key = CacheKeys.outboundMessageStanding.actor(organizationId, userId);
  const cached = await cache.getWithOutcome<unknown>(key, { keyClass: "inference_auth" });
  if (cached.kind === "hit" && isCachedStanding(cached.value, organizationId, userId)) {
    return decisionFromEntry(cached.value, "cache");
  }

  const [standing] = await dbWrite
    .select({
      userId: users.id,
      userActive: users.is_active,
      userDeletedAt: users.deleted_at,
      userLifecycleState: users.account_lifecycle_state,
      userDeletionRequestId: users.account_deletion_request_id,
      organizationId: users.organization_id,
      organizationActive: organizations.is_active,
      organizationLifecycleState: organizations.account_lifecycle_state,
      organizationLifecycleRevision: organizations.account_lifecycle_revision,
      organizationDeletionRequestId: organizations.account_deletion_request_id,
      moderationStatus: userModerationStatus.status,
      moderationViolations: userModerationStatus.totalViolations,
    })
    .from(users)
    .leftJoin(organizations, eq(organizations.id, users.organization_id))
    .leftJoin(userModerationStatus, eq(userModerationStatus.userId, users.id))
    .where(eq(users.id, userId))
    .limit(1);

  let reason: OutboundMessageStandingReason | undefined;
  if (!standing) reason = "account_missing";
  else if (
    !standing.userActive ||
    standing.userDeletedAt !== null ||
    standing.userLifecycleState !== "active" ||
    standing.userDeletionRequestId !== null
  )
    reason = "account_inactive";
  else if (!standing.organizationId || standing.organizationId !== organizationId)
    reason = "membership_missing";
  else if (
    standing.organizationLifecycleState !== "active" ||
    !organizationLifecycleAllowsNewWork({
      state: standing.organizationLifecycleState,
      revision: standing.organizationLifecycleRevision ?? 0,
      active: standing.organizationActive ?? false,
      deletionRequestId: standing.organizationDeletionRequestId,
    })
  )
    reason = "organization_inactive";
  else if (standing.moderationStatus === "banned" || (standing.moderationViolations ?? 0) >= 5)
    reason = "moderation_blocked";

  const entry: CachedStanding = {
    v: VERSION,
    organizationId,
    userId,
    cachedAt: Date.now(),
    decision: reason ? "denied" : "allowed",
    ...(reason ? { reason } : {}),
  };
  projectStanding(entry, options);
  return decisionFromEntry(entry, "authoritative");
}

/** Evict one actor or every actor in an organization after lifecycle mutation. */
export async function invalidateOutboundMessageStanding(
  organizationId: string,
  userId?: string,
): Promise<boolean> {
  return userId
    ? cache.delConfirmed(CacheKeys.outboundMessageStanding.actor(organizationId, userId), {
        keyClass: "inference_auth",
      })
    : cache.delPatternConfirmed(
        CacheKeys.outboundMessageStanding.organizationPattern(organizationId),
      );
}
