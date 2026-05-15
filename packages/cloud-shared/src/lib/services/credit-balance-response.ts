import { NotFoundError } from "../api/cloud-worker-errors";
import { organizationsService } from "./organizations";
import type { CreditBalanceResponse } from "../types/cloud-api";

export async function getCreditBalanceResponse(
  organizationId: string,
): Promise<CreditBalanceResponse> {
  const organization = await organizationsService.getById(organizationId);
  if (!organization) {
    throw NotFoundError("Organization not found");
  }

  return { balance: Number(organization.credit_balance) };
}
