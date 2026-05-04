import type { UserWithOrganization } from "@/lib/domain/user/user";
import type { UserRepository } from "@/lib/domain/user/user-repository";

export class GetUserWithOrganizationUseCase {
  constructor(private readonly users: UserRepository) {}

  execute(userId: string): Promise<UserWithOrganization | undefined> {
    return this.users.findWithOrganization(userId);
  }
}
