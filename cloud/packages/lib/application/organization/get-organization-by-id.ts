import type { Organization } from "@/lib/domain/organization/organization";
import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class GetOrganizationByIdUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  execute(id: string): Promise<Organization | undefined> {
    return this.orgs.findById(id);
  }
}
