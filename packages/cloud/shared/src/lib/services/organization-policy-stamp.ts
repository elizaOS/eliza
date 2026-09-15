/** Validates immutable cache provenance; authoritative admission must still compare against the primary policy. */
import type { OrganizationPolicyStamp } from "./organization-quota-policy";
export function isOrganizationPolicyStamp(
  value: unknown,
  now = Date.now(),
): value is OrganizationPolicyStamp {
  if (!value || typeof value !== "object") return false;
  const policy = value as Partial<OrganizationPolicyStamp>;
  if (typeof policy.generation !== "string" || !/^(0|[1-9][0-9]*)$/.test(policy.generation))
    return false;
  if (
    typeof policy.effectiveFrom !== "string" ||
    !Number.isFinite(Date.parse(policy.effectiveFrom)) ||
    Date.parse(policy.effectiveFrom) > now
  )
    return false;
  if (
    policy.effectiveUntil !== null &&
    (typeof policy.effectiveUntil !== "string" ||
      !Number.isFinite(Date.parse(policy.effectiveUntil)) ||
      now >= Date.parse(policy.effectiveUntil))
  )
    return false;
  if (policy.source === "legacy")
    return (
      policy.sourceSubscriptionId === null &&
      policy.sourceRevision === null &&
      policy.projectionRevision === null &&
      policy.catalogVersion === null
    );
  return (
    policy.source === "subscription" &&
    typeof policy.sourceSubscriptionId === "string" &&
    policy.sourceSubscriptionId.length > 0 &&
    typeof policy.sourceRevision === "string" &&
    /^[1-9][0-9]*$/.test(policy.sourceRevision) &&
    typeof policy.projectionRevision === "string" &&
    /^(0|[1-9][0-9]*)$/.test(policy.projectionRevision) &&
    typeof policy.catalogVersion === "string" &&
    policy.catalogVersion.length > 0
  );
}
export function sameOrganizationPolicyStamp(
  left: OrganizationPolicyStamp,
  right: OrganizationPolicyStamp,
): boolean {
  return (
    left.generation === right.generation &&
    left.source === right.source &&
    left.sourceSubscriptionId === right.sourceSubscriptionId &&
    left.sourceRevision === right.sourceRevision &&
    left.projectionRevision === right.projectionRevision &&
    left.catalogVersion === right.catalogVersion &&
    left.effectiveFrom === right.effectiveFrom &&
    left.effectiveUntil === right.effectiveUntil
  );
}
