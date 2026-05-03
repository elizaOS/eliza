import type {
  NewOrganization,
  Organization,
} from "@/lib/domain/organization/organization";
import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class CreateOrganizationUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  execute(data: NewOrganization): Promise<Organization> {
    return this.orgs.create(data);
  }
}
