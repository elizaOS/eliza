/** Serializes authoritative policy admission with organization lifecycle and override publication. */
import { ElizaError } from "@elizaos/core";
import { writeTransaction } from "../../db/helpers";
import { lockOrganizationPolicy } from "../../db/repositories/organization-policy-generation";
import {
  isOrganizationPolicyStamp,
  sameOrganizationPolicyStamp,
} from "./organization-policy-stamp";
import {
  type OrganizationPolicyStamp,
  type OrganizationQuotaPolicy,
  readOrganizationQuotaPolicyInTransaction,
} from "./organization-quota-policy";
export async function withOrganizationPolicyAdmission<T>(
  organizationId: string,
  expected: OrganizationPolicyStamp | undefined,
  operation: (policy: OrganizationQuotaPolicy) => Promise<T>,
): Promise<T> {
  return writeTransaction(async (tx) => {
    await lockOrganizationPolicy(tx, organizationId);
    const policy = await readOrganizationQuotaPolicyInTransaction(tx, organizationId);
    if (
      expected !== undefined &&
      (!isOrganizationPolicyStamp(expected) ||
        !sameOrganizationPolicyStamp(expected, policy.authority))
    )
      throw new ElizaError("Organization policy changed; refresh admission", {
        code: "ORGANIZATION_POLICY_STALE",
        context: { organizationId },
        severity: "ephemeral",
      });
    return operation(policy);
  });
}
