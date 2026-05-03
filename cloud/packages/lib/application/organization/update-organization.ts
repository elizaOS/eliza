import type {
  NewOrganization,
  Organization,
} from "@/lib/domain/organization/organization";
import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class UpdateOrganizationUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  execute(
    id: string,
    data: Partial<NewOrganization>,
  ): Promise<Organization | undefined> {
    return this.orgs.update(id, data);
  }
}
