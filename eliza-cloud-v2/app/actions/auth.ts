"use server";

import { requireAuthWithOrg } from "@/lib/auth";
import { organizationsService } from "@/lib/services/organizations";

/**
 * Gets the credit balance for the authenticated user's organization.
 *
 * @returns The organization's credit balance as a number, or 0 if not found.
 * @throws If the user is not authenticated or doesn't have an organization.
 */
export async function getCreditBalance(): Promise<number> {
  const user = await requireAuthWithOrg();

  const organization = await organizationsService.getById(
    user.organization_id!,
  );
  // Convert numeric type (string) to number for UI display
  return organization?.credit_balance
    ? Number.parseFloat(String(organization.credit_balance))
    : 0;
}
