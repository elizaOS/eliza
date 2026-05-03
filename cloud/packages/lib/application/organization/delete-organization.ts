import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class DeleteOrganizationUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  execute(id: string): Promise<void> {
    return this.orgs.delete(id);
  }
}
