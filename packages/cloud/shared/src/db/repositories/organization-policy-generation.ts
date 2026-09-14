/** Advances organization policy generations under the shared organization lock and records the same committed mutation. */
import { ElizaError } from "@elizaos/core";
import { eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../client";
import { organizationSubscriptionAuthorities } from "../schemas/billing-subscriptions";
import { organizationPolicyAudit } from "../schemas/organization-policy-audit";
import { organizations } from "../schemas/organizations";
export async function lockOrganizationPolicy(
  tx: DbTransaction,
  organizationId: string,
): Promise<void> {
  return lockPolicyRow(tx, organizationId, "update");
}
/** Read-only admission may overlap other readers while still fencing policy and balance writers. */
export async function lockOrganizationPolicyForRead(
  tx: DbTransaction,
  organizationId: string,
): Promise<void> {
  return lockPolicyRow(tx, organizationId, "share");
}
async function lockPolicyRow(
  tx: DbTransaction,
  organizationId: string,
  strength: "update" | "share",
): Promise<void> {
  const [organization] = await tx
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for(strength);
  if (!organization)
    throw new ElizaError("Organization policy authority does not exist", {
      code: "ORGANIZATION_POLICY_UNAVAILABLE",
      context: { organizationId },
    });
}
export async function advanceOrganizationPolicyGeneration(
  tx: DbTransaction,
  input: {
    organizationId: string;
    reason: string;
    actor: string;
    change: Record<string, string | number | boolean | null>;
  },
): Promise<bigint> {
  const [authority] = await tx
    .update(organizationSubscriptionAuthorities)
    .set({ policy_generation: sql`${organizationSubscriptionAuthorities.policy_generation} + 1` })
    .where(eq(organizationSubscriptionAuthorities.organization_id, input.organizationId))
    .returning({ generation: organizationSubscriptionAuthorities.policy_generation });
  if (!authority)
    throw new ElizaError("Organization policy generation is unavailable", {
      code: "ORGANIZATION_POLICY_UNAVAILABLE",
      context: { organizationId: input.organizationId },
    });
  await tx.insert(organizationPolicyAudit).values({
    organization_id: input.organizationId,
    generation: authority.generation,
    actor: input.actor,
    reason: input.reason,
    change: input.change,
  });
  return authority.generation;
}
