import type { Organization } from "@/lib/domain/organization/organization";
import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class GetOrganizationByStripeCustomerIdUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  execute(stripeCustomerId: string): Promise<Organization | undefined> {
    return this.orgs.findByStripeCustomerId(stripeCustomerId);
  }
}
