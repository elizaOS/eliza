// Coordinates cloud service credit balance response behavior behind route handlers.

import type { CreditBalanceResponse } from "@elizaos/cloud-shared/types";
import { ApiError, NotFoundError } from "../api/cloud-worker-errors";
import { organizationsService } from "./organizations";

export async function getCreditBalanceResponse(
  organizationId: string,
): Promise<CreditBalanceResponse> {
  const organization = await organizationsService.getById(organizationId);
  if (!organization) {
    throw NotFoundError("Organization not found");
  }

  // `credit_balance` is a Drizzle numeric (string at the row boundary). A
  // null/non-numeric value is a corrupt read, not a $0 balance. `Number(...)`
  // would hide the fault two ways: `Number(null)` is a plausible-but-wrong `0`,
  // and `Number("garbage")` is `NaN` that serializes to `balance: null`. Parse
  // via string so null/undefined/garbage all land on the same non-finite guard,
  // and fail closed with a 500 rather than reporting a success-shaped, wrong
  // balance (#12268 fallback-slop sweep).
  const balance = Number.parseFloat(String(organization.credit_balance ?? ""));
  if (!Number.isFinite(balance)) {
    throw new ApiError(500, "internal_error", "Unable to read credit balance for organization");
  }

  return { balance };
}
