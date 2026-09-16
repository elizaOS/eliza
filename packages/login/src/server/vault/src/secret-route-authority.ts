import { and, eq, inArray } from "drizzle-orm";
import {
  agents,
  type getDb,
  type SecretRoute,
  secretRoutes,
} from "../../db/src/index.ts";
import {
  secretRouteHostPatternsOverlap,
  secretRouteMethodPatternsOverlap,
  secretRoutePathPatternsOverlap,
} from "../../shared/src/index.ts";

type DbBase = ReturnType<typeof getDb>;
export type RouteAuthorityTx = Parameters<
  Parameters<DbBase["transaction"]>[0]
>[0];

export class SecretRouteAuthorityConflict extends Error {}

const GOVERNED_ROUTE_TARGET_FIELDS = [
  "secretId",
  "agentId",
  "hostPattern",
  "pathPattern",
  "method",
  "injectAs",
  "injectKey",
  "injectFormat",
  "injectionStrategy",
  "injectionConfig",
] as const;

type RouteAuthorityCandidate = Pick<
  SecretRoute,
  | "id"
  | "tenantId"
  | "hostPattern"
  | "pathPattern"
  | "method"
  | "enabled"
  | "authorityMode"
> & { agentId: string };

export function secretRouteAuthorityPatternsOverlap(
  left: Pick<RouteAuthorityCandidate, "hostPattern" | "pathPattern" | "method">,
  right: Pick<
    RouteAuthorityCandidate,
    "hostPattern" | "pathPattern" | "method"
  >,
): boolean {
  return (
    secretRouteHostPatternsOverlap(left.hostPattern, right.hostPattern) &&
    secretRoutePathPatternsOverlap(
      left.pathPattern ?? "/*",
      right.pathPattern ?? "/*",
    ) &&
    secretRouteMethodPatternsOverlap(left.method, right.method)
  );
}

export function assertGovernedRouteUpdateIsSafe(
  existing: SecretRoute,
  update: Partial<
    Pick<
      SecretRoute,
      | "secretId"
      | "agentId"
      | "hostPattern"
      | "pathPattern"
      | "method"
      | "injectAs"
      | "injectKey"
      | "injectFormat"
      | "injectionStrategy"
      | "injectionConfig"
      | "enabled"
    >
  >,
): void {
  if (existing.authorityMode !== "governed_v2") return;
  const changesTarget = GOVERNED_ROUTE_TARGET_FIELDS.some(
    (field) => update[field] !== undefined && update[field] !== existing[field],
  );
  if (
    changesTarget ||
    (existing.enabled === false && update.enabled === true)
  ) {
    throw new SecretRouteAuthorityConflict(
      "governed route targets can only be changed through provider operation authoring",
    );
  }
}

/**
 * Serialize every authority-changing mutation for an agent route namespace.
 * Sorting makes a route move between two agents deadlock-safe.
 */
export async function lockSecretRouteNamespaces(
  tx: RouteAuthorityTx,
  tenantId: string,
  agentIds: readonly string[],
): Promise<void> {
  const uniqueIds = [...new Set(agentIds)].sort();
  if (uniqueIds.length === 0) return;
  const locked = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.tenantId, tenantId), inArray(agents.id, uniqueIds)))
    .orderBy(agents.id)
    .for("update");
  if (locked.length !== uniqueIds.length) {
    throw new SecretRouteAuthorityConflict(
      "agent route namespace no longer exists",
    );
  }
}

/** Fail closed when an enabled route overlaps a route under the other authority model. */
export async function assertNoOppositeAuthorityOverlap(
  tx: RouteAuthorityTx,
  candidate: RouteAuthorityCandidate,
): Promise<void> {
  if (!candidate.enabled) return;
  const siblings = await tx
    .select()
    .from(secretRoutes)
    .where(
      and(
        eq(secretRoutes.tenantId, candidate.tenantId),
        eq(secretRoutes.agentId, candidate.agentId),
      ),
    );
  const ambiguous = siblings.some(
    (sibling) =>
      sibling.id !== candidate.id &&
      sibling.authorityMode !== candidate.authorityMode &&
      // A governed route reserves its namespace even while disabled: otherwise
      // disable -> create/enable legacy -> direct credential injection bypasses
      // the provider operation. Disabled legacy routes do not reserve anything;
      // promotion only conflicts with a legacy route that can actually inject.
      (candidate.authorityMode === "legacy" || sibling.enabled) &&
      secretRouteAuthorityPatternsOverlap(candidate, sibling),
  );
  if (ambiguous) {
    throw new SecretRouteAuthorityConflict(
      "credential route overlaps an enabled route under a different authority model",
    );
  }
}
