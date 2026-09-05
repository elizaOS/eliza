/**
 * Validates balance and revision fields read from the authoritative organization
 * row so inference hydration and direct credit reads share one parsing contract.
 */
import { ElizaError } from "@elizaos/core";
import type { Organization } from "../../db/schemas/organizations";

export interface OrganizationBalanceSnapshot {
  balanceUsd: number;
  revision: string;
}

export function parseOrganizationBalanceSnapshot(
  organization: Pick<Organization, "credit_balance" | "balance_revision">,
): OrganizationBalanceSnapshot {
  const revision = String(organization.balance_revision);
  if (!/^(0|[1-9]\d*)$/.test(revision)) {
    throw new ElizaError("[CreditsService] Invalid organization balance revision", {
      code: "INVALID_ORGANIZATION_BALANCE_REVISION",
    });
  }
  const balanceUsd = Number.parseFloat(String(organization.credit_balance ?? ""));
  if (!Number.isFinite(balanceUsd)) {
    throw new ElizaError("[CreditsService] Invalid numeric credit_balance", {
      code: "INVALID_ORGANIZATION_CREDIT_BALANCE",
    });
  }
  return { balanceUsd, revision };
}
