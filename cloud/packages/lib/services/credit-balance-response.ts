import { NotFoundError } from "@/lib/api/cloud-worker-errors";
import { organizationsService } from "@/lib/services/organizations";
import type { CreditBalanceResponse } from "@/lib/types/cloud-api";

export async function getCreditBalanceResponse(
  organizationId: string,
): Promise<CreditBalanceResponse> {
  const organization = await organizationsService.getById(organizationId);
  if (!organization) {
    throw NotFoundError("Organization not found");
  }

  return { balance: Number(organization.credit_balance) };
}
