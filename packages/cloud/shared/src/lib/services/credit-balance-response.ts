// Coordinates cloud service credit balance response behavior behind route handlers.
import { NotFoundError } from "../api/cloud-worker-errors";
import type { CreditBalanceResponse } from "../types/cloud-api";
import { organizationsService } from "./organizations";
import { parseStrictFiniteNumber } from "./strict-numeric";

export async function getCreditBalanceResponse(
  organizationId: string,
): Promise<CreditBalanceResponse> {
  const organization = await organizationsService.getById(organizationId);
  if (!organization) {
    throw NotFoundError("Organization not found");
  }

  return {
    balance: parseStrictFiniteNumber(
      organization.credit_balance,
      "organization.credit_balance",
      "CreditBalanceResponse",
    ),
  };
}
