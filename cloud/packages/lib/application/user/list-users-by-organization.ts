import type { User } from "@/lib/domain/user/user";
import type { UserRepository } from "@/lib/domain/user/user-repository";

export class ListUsersByOrganizationUseCase {
  constructor(private readonly users: UserRepository) {}

  execute(organizationId: string): Promise<User[]> {
    return this.users.listByOrganization(organizationId);
  }
}
