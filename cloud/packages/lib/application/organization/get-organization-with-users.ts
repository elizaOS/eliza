import type { OrganizationRepository } from "@/lib/domain/organization/organization-repository";

export class GetOrganizationWithUsersUseCase {
  constructor(private readonly orgs: OrganizationRepository) {}

  execute(id: string): Promise<unknown> {
    return this.orgs.findWithUsers(id);
  }
}
