import type { UpdateCreditBalanceResult } from "@/lib/domain/organization/organization";
import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class UpdateOrganizationCreditBalanceUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  execute(
    organizationId: string,
    amount: number,
  ): Promise<UpdateCreditBalanceResult> {
    return this.orgs.updateCreditBalance(organizationId, amount);
  }
}
