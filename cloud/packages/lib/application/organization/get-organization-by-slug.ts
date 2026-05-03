import type { Organization } from "@/lib/domain/organization/organization";
import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class GetOrganizationBySlugUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  execute(slug: string): Promise<Organization | undefined> {
    return this.orgs.findBySlug(slug);
  }
}
